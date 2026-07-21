import { randomUUID } from 'node:crypto'

import {
	// 从 inputResponses 中解析某个输入请求的用户提交内容
	acceptedContent,

	// 构造 resultType: "input_required" 类型的 Tool 返回结果
	inputRequired,

	// 读取某个 inputResponse，判断用户是 accept、decline 还是 cancel
	inputResponse,

	// 用于创建和注册 MCP Server、Tool 等能力
	McpServer
} from '@modelcontextprotocol/server'

// 使用 stdio 传输层启动 MCP Server
import { serveStdio } from '@modelcontextprotocol/server/stdio'

// 使用 Zod 声明和校验 Tool 输入及用户返回的数据
import * as z from 'zod/v4'

/**
 * 模拟后台任务存储。
 *
 * key：任务 ID，也就是 jobId
 * value：任务相关数据，例如订单 ID 和任务创建时间
 *
 * 真实项目中通常会把任务保存到数据库、Redis
 * 或专门的任务队列中，而不是保存在当前进程内存里。
 */
const jobs = new Map()

/**
 * Server 请求 Host 收集用户确认信息时使用的 JSON Schema。
 *
 * Host 可以根据这份 Schema 生成确认框、表单
 * 或命令行交互界面。
 *
 * 用户最终需要返回类似的数据：
 *
 * {
 *   "confirm": true
 * }
 */
const confirmationSchema = {
	type: 'object',
	properties: {
		confirm: {
			type: 'boolean',
			description: '是否确认启动批量退款审核'
		}
	},
	required: ['confirm']
}

/**
 * 用于在 Server 端校验用户返回的确认结果。
 *
 * confirmationSchema 是交给 Host 的 JSON Schema；
 * confirmationResponseSchema 是 Server 内部使用的 Zod Schema。
 */
const confirmationResponseSchema = z.object({
	confirm: z.boolean()
})

/**
 * 根据任务创建时间模拟后台审核进度。
 *
 * 真实项目通常会从任务队列、数据库或任务调度系统中
 * 查询当前任务的状态、进度和执行结果。
 */
function getJobSnapshot(job) {
	// 计算任务已经执行了多长时间
	const elapsedMs = Date.now() - job.createdAt

	// 创建后 1 秒内，模拟正在读取订单信息
	if (elapsedMs < 1000) {
		return {
			status: 'working',
			progress: 30,
			message: '正在读取订单信息'
		}
	}

	// 创建后 1～2 秒，模拟正在检查退款规则
	if (elapsedMs < 2000) {
		return {
			status: 'working',
			progress: 70,
			message: '正在检查退款规则'
		}
	}

	// 超过 2 秒后，模拟任务执行完成
	return {
		status: 'completed',
		progress: 100,
		message: '审核完成',

		// 模拟批量退款审核结果
		result: {
			// 本次审核的订单总数
			total: job.orderIds.length,

			// 演示规则：
			// A1024 需要进入人工审核
			manualReview: job.orderIds.filter((orderId) => orderId === 'A1024'),

			// 其他订单自动审核通过
			autoApproved: job.orderIds.filter((orderId) => orderId !== 'A1024')
		}
	}
}

/**
 * 创建演示用 MCP Server。
 *
 * Server 对外暴露两个 Tool：
 *
 * 1. start_batch_refund_review
 *    请求用户确认，并在确认后创建后台审核任务。
 *
 * 2. get_refund_review_status
 *    根据 jobId 查询后台任务的执行进度和结果。
 */
function createServer() {
	const server = new McpServer(
		{
			// MCP Server 的名称和版本
			name: 'refund-review-extension-server',
			version: '1.0.0'
		},
		{
			capabilities: {
				// 声明当前 Server 支持 Tools 能力
				tools: {}
			}
		}
	)

	/**
	 * 注册启动批量退款审核的 Tool。
	 *
	 * 这个 Tool 使用 Multi Round-Trip Requests：
	 *
	 * 第一次调用：
	 * Server 没有拿到用户确认结果，返回 input_required。
	 *
	 * 第二次调用：
	 * Host 收集用户答案后，携带 inputResponses
	 * 重新调用这个 Tool。
	 */
	server.registerTool(
		'start_batch_refund_review',
		{
			description: '经用户确认后，创建一项批量退款审核任务',

			// Tool 的业务参数：
			// 至少需要传入一个待审核订单 ID
			inputSchema: z.object({
				orderIds: z.array(z.string()).min(1)
			})
		},
		async ({ orderIds }, context) => {
			/**
			 * 从当前 MCP 请求的 inputResponses 中，
			 * 读取标识为 confirm 的用户输入响应。
			 *
			 * 第一次调用时通常不存在 inputResponses，
			 * 此时 response 不会表示已接受的 Elicitation 结果。
			 *
			 * 第二次调用时，可能读取到类似的数据：
			 *
			 * {
			 *   "confirm": {
			 *     "action": "accept",
			 *     "content": {
			 *       "confirm": true
			 *     }
			 *   }
			 * }
			 */
			const response = inputResponse(context.mcpReq.inputResponses, 'confirm')

			/**
			 * 如果已经存在 Elicitation 响应，
			 * 但用户没有选择 accept，则认为用户取消或拒绝了操作。
			 *
			 * 注意：
			 * action !== "accept" 表示用户没有提交确认表单，
			 * 与 content.confirm === false 是不同的含义。
			 */
			if (response.kind === 'elicit' && response.action !== 'accept') {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: '用户取消了批量退款审核'
						}
					]
				}
			}

			/**
			 * 读取并校验用户在 confirm 请求中提交的 content。
			 *
			 * acceptedContent 只会读取 action 为 accept 的响应，
			 * 并使用 confirmationResponseSchema 校验 content。
			 *
			 * 校验成功后，confirmation 的结构类似：
			 *
			 * {
			 *   confirm: true
			 * }
			 */
			const confirmation = acceptedContent(
				context.mcpReq.inputResponses,
				'confirm',
				confirmationResponseSchema
			)

			/**
			 * 如果当前还没有拿到用户的明确确认，
			 * 就暂不创建后台任务，而是返回 input_required。
			 *
			 * 本次 Tool 调用会在这里结束。
			 * Host 收集完用户答案后，需要携带 inputResponses
			 * 再次调用 start_batch_refund_review。
			 */
			if (!confirmation?.confirm) {
				return inputRequired({
					inputRequests: {
						/**
						 * confirm 是本次输入请求的唯一标识。
						 *
						 * Host 后续提交 inputResponses 时，
						 * 也需要使用相同的 confirm 作为 key。
						 */
						confirm: inputRequired.elicit({
							// Host 展示给用户的提示信息
							message: `即将审核 ${orderIds.length} 笔退款订单，是否继续？`,

							// Host 需要按照这份 JSON Schema 收集用户输入
							requestedSchema: confirmationSchema
						})
					}
				})
			}

			/**
			 * 只有在用户明确提交：
			 *
			 * {
			 *   "confirm": true
			 * }
			 *
			 * 后，才会真正创建后台审核任务。
			 */

			// 为后台任务生成唯一 ID
			const jobId = randomUUID()

			// 保存任务参数和创建时间
			jobs.set(jobId, {
				orderIds,
				createdAt: Date.now()
			})

			/**
			 * Tool 不等待后台任务执行完成，
			 * 而是立即返回 jobId。
			 *
			 * Host 后续可以调用 get_refund_review_status
			 * 轮询任务状态。
			 */
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							jobId,
							status: 'working',
							message: '批量退款审核任务已经创建'
						})
					}
				]
			}
		}
	)

	/**
	 * 注册查询批量退款审核状态的 Tool。
	 *
	 * Host 获取 jobId 后，可以重复调用该 Tool，
	 * 直到任务状态变成 completed。
	 */
	server.registerTool(
		'get_refund_review_status',
		{
			description: '根据任务 ID 查询批量退款审核进度和结果',

			// 查询任务时必须传入任务 ID
			inputSchema: z.object({
				jobId: z.string()
			})
		},
		async ({ jobId }) => {
			// 根据 jobId 查找后台任务
			const job = jobs.get(jobId)

			// 找不到任务时返回 Tool 执行错误
			if (!job) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: `没有找到任务：${jobId}`
						}
					]
				}
			}

			/**
			 * 返回当前任务的状态快照。
			 *
			 * 可能返回：
			 * - working：任务仍在执行
			 * - completed：任务已经完成
			 */
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							jobId,
							...getJobSnapshot(job)
						})
					}
				]
			}
		}
	)

	return server
}

/**
 * 创建 MCP Server，并通过 stdio 传输层启动。
 *
 * MCP Client 可以通过当前进程的 stdin 和 stdout
 * 与这个 MCP Server 交换协议消息。
 */
await serveStdio(createServer)

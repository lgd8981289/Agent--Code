import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/**
 * 获取 MCP Server 文件的绝对路径。
 *
 * 后面创建 StdioClientTransport 时，
 * MCP Client 会通过 Node.js 子进程启动这个 Server。
 */
const serverPath = fileURLToPath(
	new URL('./refund-review-mcp-server.js', import.meta.url)
)

/**
 * 判断启动命令中是否包含 --yes。
 *
 * 例如：
 *
 * node refund-review-host.js --yes
 *
 * 如果包含 --yes，就自动确认，不再等待用户在终端输入。
 */
const autoConfirm = process.argv.includes('--yes')

/**
 * 暂停指定的时间。
 *
 * 后面轮询后台任务状态时使用，
 * 避免连续、无间隔地调用状态查询 Tool。
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 读取 MCP Tool 返回的第一段文本，并转换成 JSON。
 *
 * MCP Tool 的 content 通常是一个内容块数组，例如：
 *
 * {
 *   content: [
 *     {
 *       type: 'text',
 *       text: '{"jobId":"xxx","status":"working"}'
 *     }
 *   ]
 * }
 *
 * 这个函数会找到第一段 text 内容，
 * 再通过 JSON.parse() 转换成 JavaScript 对象。
 */
function parseToolJson(result) {
	const block = result.content?.find((item) => item.type === 'text')

	if (!block) {
		throw new Error('Tool 没有返回文本结果')
	}

	return JSON.parse(block.text)
}

/**
 * 启动 Host 的完整执行流程：
 *
 * 1. 创建 MCP Client
 * 2. 连接 MCP Server
 * 3. 调用批量退款审核 Tool
 * 4. 在需要时向用户收集确认信息
 * 5. 获取后台任务 jobId
 * 6. 轮询任务状态，直到审核完成
 */
async function main() {
	/**
	 * 创建 MCP Client。
	 *
	 * 这里的程序整体属于 Host，
	 * client 对象只是 Host 内部负责 MCP 协议通信的组件。
	 *
	 * MCP Client 本身不负责调用大模型，
	 * 也不负责决定什么时候需要执行退款审核。
	 */
	const client = new Client(
		{
			// 当前 Client 的名称和版本
			name: 'refund-review-extension-host',
			version: '1.0.0'
		},
		{
			/**
			 * 自动与 Server 协商 MCP 协议版本。
			 *
			 * Client 会根据双方支持的协议版本，
			 * 选择可以共同使用的版本和交互方式。
			 */
			versionNegotiation: {
				mode: 'auto'
			},

			/**
			 * 声明 Client 支持 Elicitation 表单能力。
			 *
			 * 这表示：
			 * 当 Server 需要补充用户输入时，
			 * Client / Host 有能力根据 requestedSchema
			 * 收集结构化表单数据。
			 */
			capabilities: {
				elicitation: {
					form: {}
				}
			}
		}
	)

	/**
	 * 创建 stdio 传输层。
	 *
	 * Client 会启动下面的 MCP Server：
	 *
	 * node refund-review-mcp-server.js
	 *
	 * 启动后，Client 与 Server 通过 stdin 和 stdout
	 * 交换 MCP 协议消息。
	 */
	const transport = new StdioClientTransport({
		// 使用当前 Node.js 可执行程序启动 Server
		command: process.execPath,

		// Server 文件路径
		args: [serverPath],

		// 把 Server 的 stderr 日志显示在当前终端中
		stderr: 'inherit'
	})

	/**
	 * 注册 Elicitation 请求处理器。
	 *
	 * 当 Server 请求收集用户输入时，
	 * Client 会把 elicitation/create 请求交给这个处理函数。
	 *
	 * 具体使用终端、网页弹窗还是桌面表单，
	 * 是 Host 的职责，MCP Server 不关心界面如何实现。
	 */
	client.setRequestHandler('elicitation/create', async (request) => {
		// Server 希望展示给用户的提示信息
		const message = request.params.message

		// 使用 --yes 启动时，默认直接确认
		let confirmed = autoConfirm

		/**
		 * 如果没有启用自动确认，
		 * 就在终端中询问用户是否继续执行。
		 */
		if (!autoConfirm) {
			const terminal = createInterface({
				input: process.stdin,
				output: process.stdout
			})

			// 等待用户输入 y 或 n
			const answer = await terminal.question(`${message}（y/n）：`)

			// 用户输入完成后关闭 readline
			terminal.close()

			// 只有输入 y 时才认为用户确认继续
			confirmed = answer.trim().toLowerCase() === 'y'
		}

		console.log(`Host 收集到的确认结果：${confirmed ? '继续执行' : '取消执行'}`)

		/**
		 * 把用户的选择转换成 Elicitation 响应。
		 *
		 * 用户确认时返回：
		 *
		 * {
		 *   action: 'accept',
		 *   content: {
		 *     confirm: true
		 *   }
		 * }
		 *
		 * 其中：
		 *
		 * action: 'accept'
		 * 表示用户接受并提交了本次输入请求。
		 *
		 * content.confirm: true
		 * 表示用户在具体业务上同意启动批量退款审核。
		 */
		return confirmed
			? {
					action: 'accept',
					content: {
						confirm: true
					}
				}
			: {
					/**
					 * decline 表示用户拒绝本次输入请求，
					 * 因此不需要再提供 content。
					 */
					action: 'decline'
				}
	})

	try {
		/**
		 * 建立 MCP 连接。
		 *
		 * 在 stdio 模式下，这一步会启动 MCP Server 子进程，
		 * 并完成初始化与协议版本协商。
		 */
		await client.connect(transport)

		console.log('\n一、调用 start_batch_refund_review')

		/**
		 * 调用启动批量退款审核的 Tool。
		 *
		 * 第一次调用时没有用户确认结果，
		 * Server 会请求 Host 收集确认信息。
		 *
		 * SDK 会将需要处理的 Elicitation 请求
		 * 交给前面注册的 elicitation/create 处理器。
		 */
		const startResult = await client.callTool({
			name: 'start_batch_refund_review',
			arguments: {
				orderIds: ['A1024', 'A1025', 'A1026']
			}
		})

		/**
		 * 如果用户拒绝确认，或者 Server 执行失败，
		 * Tool 可能返回 isError: true。
		 */
		if (startResult.isError) {
			const errorBlock = startResult.content?.find(
				(item) => item.type === 'text'
			)

			console.log(errorBlock?.text ?? '批量退款审核没有启动')
			return
		}

		/**
		 * 用户确认后，Server 会创建后台任务，
		 * 并返回包含 jobId 的 JSON 文本。
		 */
		const task = parseToolJson(startResult)

		console.log('任务创建结果：', task)

		console.log('\n二、轮询 get_refund_review_status')

		/**
		 * 持续查询后台任务状态，
		 * 直到任务状态变成 completed。
		 */
		while (true) {
			// 每隔 700 毫秒查询一次，避免过于频繁地调用 Tool
			await sleep(700)

			/**
			 * 根据任务创建时返回的 jobId，
			 * 调用状态查询 Tool。
			 */
			const statusResult = await client.callTool({
				name: 'get_refund_review_status',
				arguments: {
					jobId: task.jobId
				}
			})

			// 把 Tool 返回的 JSON 文本转换成对象
			const snapshot = parseToolJson(statusResult)

			// 输出当前任务进度
			console.log(
				`[${snapshot.progress}%] ${snapshot.status}：${snapshot.message}`
			)

			/**
			 * 任务完成后输出最终结果，
			 * 并退出轮询循环。
			 */
			if (snapshot.status === 'completed') {
				console.log('最终审核结果：', snapshot.result)
				break
			}
		}
	} finally {
		/**
		 * 无论任务正常完成还是执行过程中发生异常，
		 * 最终都关闭 MCP Client 与 Server 之间的连接。
		 *
		 * 在 stdio 模式下，这通常也会结束对应的 Server 子进程。
		 */
		await client.close()
	}
}

// 启动 Host
await main()

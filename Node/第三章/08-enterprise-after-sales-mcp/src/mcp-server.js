import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool
} from '@modelcontextprotocol/ext-apps/server'
import {
	acceptedContent,
	createRequestStateCodec,
	inputRequired,
	inputResponse,
	McpServer
} from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

import {
	cancelBatchReview,
	getAuditLogs,
	getJobSnapshot,
	getLogistics,
	getOrder,
	getPolicy,
	getRefundByIdempotencyKey,
	previewRefund,
	searchPolicies,
	startBatchReview,
	submitRefund
} from './after-sales-service.js'

const APP_URI = 'ui://after-sales/batch-review-report.html'

const requestStateCodec = createRequestStateCodec({
	key:
		process.env.REQUEST_STATE_SECRET ??
		'course-demo-request-state-secret-2026-change-me',
	ttlSeconds: 300,
	bind: (context) =>
		`${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? 'anonymous'}`
})

const confirmationResponseSchema = z.object({
	confirm: z.boolean()
})

function jsonResult(data, isError = false) {
	return {
		isError,
		structuredContent: data,
		content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
	}
}

function businessResult(result) {
	return jsonResult(result, result.ok === false)
}

function cancelledResult(message) {
	return jsonResult(
		{ ok: false, error: { code: 'USER_CANCELLED', message } },
		true
	)
}

/**
 * 注册所有客服和财务都能使用的基础能力。
 */
function registerCommonCapabilities(server, principal) {
	server.registerTool(
		'get_order_detail',
		{
			title: '查询订单详情',
			description: '根据订单号查询当前企业的订单详情',
			inputSchema: z.object({
				orderId: z.string().describe('订单号，例如 A1024')
			}),
			annotations: { readOnlyHint: true, idempotentHint: true }
		},
		async ({ orderId }) => businessResult(getOrder(principal, orderId))
	)

	server.registerTool(
		'get_logistics_trace',
		{
			title: '查询物流轨迹',
			description: '根据订单号查询当前企业的物流轨迹',
			inputSchema: z.object({ orderId: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true }
		},
		async ({ orderId }) => businessResult(getLogistics(principal, orderId))
	)

	server.registerTool(
		'search_after_sales_policy',
		{
			title: '检索售后规则',
			description: '根据用户问题检索当前企业的售后规则',
			inputSchema: z.object({ query: z.string().min(1) }),
			annotations: { readOnlyHint: true, idempotentHint: true }
		},
		async ({ query }) => businessResult(searchPolicies(principal, query))
	)

	server.registerTool(
		'preview_refund',
		{
			title: '退款预检',
			description: '只做退款资格和人工审核判断，不会创建退款申请',
			inputSchema: z.object({
				orderId: z.string(),
				reason: z.string().min(2)
			}),
			annotations: { readOnlyHint: true, idempotentHint: true }
		},
		async ({ orderId, reason }) =>
			businessResult(previewRefund(principal, orderId, reason))
	)

	server.registerTool(
		'submit_refund_request',
		{
			title: '提交退款申请',
			description: '经用户确认后创建退款申请，相同幂等键不会重复创建',
			inputSchema: z.object({
				orderId: z.string(),
				reason: z.string().min(2),
				idempotencyKey: z.string().min(8).describe('调用方生成的唯一幂等键')
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true
			}
		},
		async (args, context) => {
			const existingRefund = getRefundByIdempotencyKey(
				principal,
				args.idempotencyKey
			)

			if (existingRefund) {
				return jsonResult({
					ok: true,
					duplicated: true,
					refundRequest: existingRefund
				})
			}

			const previousState = context.mcpReq.requestState()
			const response = inputResponse(
				context.mcpReq.inputResponses,
				'confirm-refund'
			)

			if (response.kind === 'elicit' && response.action !== 'accept') {
				return cancelledResult('用户取消了退款提交')
			}

			const confirmation = acceptedContent(
				context.mcpReq.inputResponses,
				'confirm-refund',
				confirmationResponseSchema
			)

			if (!confirmation?.confirm) {
				const preview = previewRefund(principal, args.orderId, args.reason)
				if (!preview.ok || !preview.preview.eligible) return businessResult(preview)

				const requestState = await requestStateCodec.mint(
					{ operation: 'submit_refund_request', ...args },
					context
				)

				return inputRequired({
					requestState,
					inputRequests: {
						'confirm-refund': inputRequired.elicit({
							message: `即将为订单 ${args.orderId} 创建 ${preview.preview.refundAmount} 元退款申请，是否继续？`,
							requestedSchema: {
								type: 'object',
								properties: { confirm: { type: 'boolean' } },
								required: ['confirm']
							}
						})
					}
				})
			}

			if (
				previousState?.operation !== 'submit_refund_request' ||
				previousState.orderId !== args.orderId ||
				previousState.idempotencyKey !== args.idempotencyKey
			) {
				return jsonResult(
					{ ok: false, error: { code: 'INVALID_REQUEST_STATE', message: '确认信息与当前退款请求不一致' } },
					true
				)
			}

			return businessResult(submitRefund(principal, args))
		}
	)

	server.registerResource(
		'refund-policy',
		'after-sales://policies/refund-policy',
		{
			title: '当前企业退款规则',
			description: '根据登录身份返回当前企业自己的退款规则',
			mimeType: 'text/markdown'
		},
		async (uri) => {
			const result = getPolicy(principal, 'refund-policy')
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'text/markdown',
						text: result.ok
							? `# ${result.policy.title}\n\n${result.policy.content}`
							: result.error.message
					}
				]
			}
		}
	)

	server.registerPrompt(
		'handle_after_sales_case',
		{
			title: '售后问题处理模板',
			description: '要求 Agent 先查询事实，再决定是否执行退款操作',
			argsSchema: z.object({
				orderId: z.string(),
				customerQuestion: z.string()
			})
		},
		({ orderId, customerQuestion }) => ({
			description: '企业售后 Agent 处理模板',
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: [
							'你是企业售后 Agent。',
							'先调用只读工具核对订单和规则，不允许根据用户描述猜测业务事实。',
							'只有用户明确要求提交退款时，才可以调用 submit_refund_request。',
							`订单号：${orderId}`,
							`用户问题：${customerQuestion}`
						].join('\n')
					}
				}
			]
		}))
}

/** 财务角色额外拥有批量审核、取消、审计和报告 App。 */
function registerFinanceCapabilities(server, principal, appHtml) {
	server.registerTool(
		'start_batch_refund_review',
		{
			title: '启动批量退款审核',
			description: '经确认后创建批量退款审核后台任务，并立即返回 jobId',
			inputSchema: z.object({
				orderIds: z.array(z.string()).min(1).max(20)
			}),
			annotations: { readOnlyHint: false, destructiveHint: true }
		},
		async ({ orderIds }, context) => {
			const previousState = context.mcpReq.requestState()
			const response = inputResponse(context.mcpReq.inputResponses, 'confirm-batch')

			if (response.kind === 'elicit' && response.action !== 'accept') {
				return cancelledResult('用户取消了批量退款审核')
			}

			const confirmation = acceptedContent(
				context.mcpReq.inputResponses,
				'confirm-batch',
				confirmationResponseSchema
			)

			if (!confirmation?.confirm) {
				const requestState = await requestStateCodec.mint(
					{ operation: 'start_batch_refund_review', orderIds },
					context
				)

				return inputRequired({
					requestState,
					inputRequests: {
						'confirm-batch': inputRequired.elicit({
							message: `即将审核 ${orderIds.length} 笔退款订单，是否继续？`,
							requestedSchema: {
								type: 'object',
								properties: { confirm: { type: 'boolean' } },
								required: ['confirm']
							}
						})
					}
				})
			}

			if (
				previousState?.operation !== 'start_batch_refund_review' ||
				JSON.stringify(previousState.orderIds) !== JSON.stringify(orderIds)
			) {
				return jsonResult(
					{ ok: false, error: { code: 'INVALID_REQUEST_STATE', message: '确认信息与当前批量任务不一致' } },
					true
				)
			}

			return businessResult(startBatchReview(principal, orderIds))
		}
	)

	server.registerTool(
		'get_batch_review_status',
		{
			title: '查询批量审核状态',
			description: '根据 jobId 查询后台审核任务的进度和结果',
			inputSchema: z.object({ jobId: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true }
		},
		async ({ jobId }) => businessResult(getJobSnapshot(principal, jobId))
	)

	server.registerTool(
		'cancel_batch_review',
		{
			title: '取消批量审核',
			description: '取消尚未执行完成的批量退款审核任务',
			inputSchema: z.object({ jobId: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: true }
		},
		async ({ jobId }) => businessResult(cancelBatchReview(principal, jobId))
	)

	server.registerResource(
		'recent-audit-logs',
		'after-sales://audit/recent',
		{
			title: '近期售后审计记录',
			description: '当前企业最近的退款和批量审核操作记录',
			mimeType: 'application/json'
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(getAuditLogs(principal).slice(-20), null, 2)
				}
			]
		})
	)

	registerAppTool(
		server,
		'get_batch_review_report',
		{
			title: '查看批量审核报告',
			description: '读取已完成的批量审核结果，并使用 MCP App 展示报告',
			inputSchema: z.object({ jobId: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
			_meta: { ui: { resourceUri: APP_URI } }
		},
		async ({ jobId }) => businessResult(getJobSnapshot(principal, jobId))
	)

	registerAppResource(
		server,
		'批量退款审核报告',
		APP_URI,
		{ description: '以可视化界面展示批量退款审核结果' },
		async () => ({
			contents: [
				{
					uri: APP_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: appHtml,
					_meta: { ui: { prefersBorder: false } }
				}
			]
		})
	)
}

/**
 * 每个 HTTP 请求都会创建新的 MCP Server，但共享外部业务服务中的状态。
 */
export function createAfterSalesMcpServer({ principal, appHtml }) {
	const server = new McpServer(
		{
			name: 'enterprise-after-sales-mcp',
			version: '1.0.0'
		},
		{
			capabilities: { tools: {}, resources: {}, prompts: {} },
			requestState: { verify: requestStateCodec.verify }
		}
	)

	registerCommonCapabilities(server, principal)
	if (principal.role === 'finance') {
		registerFinanceCapabilities(server, principal, appHtml)
	}

	return server
}

import { createAfterSalesClient, parseToolResult } from './mcp-client.js'

function title(text) {
	console.log(`\n================ ${text} ================`)
}

function assert(condition, message) {
	if (!condition) throw new Error(`验证失败：${message}`)
	console.log(`✓ ${message}`)
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function call(client, name, args) {
	return parseToolResult(await client.callTool({ name, arguments: args }))
}

let serviceClient
let financeClient
let starClient

try {
	serviceClient = await createAfterSalesClient({ token: 'token-blue-service' })
	financeClient = await createAfterSalesClient({ token: 'token-blue-finance' })
	starClient = await createAfterSalesClient({ token: 'token-star-service' })

	title('1. 能力发现与角色权限')
	const serviceTools = (await serviceClient.listTools()).tools
	const financeTools = (await financeClient.listTools()).tools
	assert(serviceTools.some((tool) => tool.name === 'preview_refund'), '客服可以发现退款预检 Tool')
	assert(!serviceTools.some((tool) => tool.name === 'start_batch_refund_review'), '客服看不到财务批量审核 Tool')
	assert(financeTools.some((tool) => tool.name === 'start_batch_refund_review'), '财务可以发现批量审核 Tool')

	title('2. 同订单号下的租户隔离')
	const blueOrder = await call(serviceClient, 'get_order_detail', { orderId: 'A1024' })
	const starOrder = await call(starClient, 'get_order_detail', { orderId: 'A1024' })
	console.log('蓝鲸科技：', blueOrder.order.productName)
	console.log('星河零售：', starOrder.order.productName)
	assert(blueOrder.order.productName !== starOrder.order.productName, '订单查询始终使用登录人的 tenantId')

	title('3. Tool、Resource 与 Prompt')
	const preview = await call(serviceClient, 'preview_refund', {
		orderId: 'A1024',
		reason: '商品不符合预期'
	})
	console.dir(preview, { depth: null })
	assert(preview.preview.manualReview === true, '3000 元退款被确定性规则判定为人工审核')

	const policy = await serviceClient.readResource({
		uri: 'after-sales://policies/refund-policy'
	})
	console.log(policy.contents[0]?.text)
	assert(policy.contents[0]?.text.includes('蓝鲸科技'), 'Resource 返回当前租户的规则')

	const prompt = await serviceClient.getPrompt({
		name: 'handle_after_sales_case',
		arguments: { orderId: 'A1024', customerQuestion: '可以退款吗？' }
	})
	assert(prompt.messages.length === 1, 'Host 可以获取售后任务 Prompt')

	title('4. Human-in-the-Loop 与幂等退款')
	const idempotencyKey = `course-refund-${Date.now()}`
	const firstRefund = await call(serviceClient, 'submit_refund_request', {
		orderId: 'A1024',
		reason: '商品不符合预期',
		idempotencyKey
	})
	const secondRefund = await call(serviceClient, 'submit_refund_request', {
		orderId: 'A1024',
		reason: '商品不符合预期',
		idempotencyKey
	})
	console.dir(firstRefund, { depth: null })
	assert(firstRefund.refundRequest.refundId === secondRefund.refundRequest.refundId, '重复调用没有创建第二张退款单')
	assert(secondRefund.duplicated === true, '第二次调用被识别为幂等重试')

	title('5. 业务长任务')
	const started = await call(financeClient, 'start_batch_refund_review', {
		orderIds: ['A1024', 'A1025', 'A1026']
	})
	console.log('创建任务：', started.job.jobId)

	let snapshot
	do {
		await sleep(500)
		snapshot = await call(financeClient, 'get_batch_review_status', {
			jobId: started.job.jobId
		})
		console.log(`[${snapshot.job.progress}%] ${snapshot.job.message}`)
	} while (snapshot.job.status === 'working')

	assert(snapshot.job.status === 'completed', 'Client 通过 jobId 取回长任务结果')
	console.table(snapshot.job.result.details)

	title('6. MCP App')
	const reportTool = financeTools.find((tool) => tool.name === 'get_batch_review_report')
	const appUri = reportTool?._meta?.ui?.resourceUri
	assert(appUri === 'ui://after-sales/batch-review-report.html', '报告 Tool 声明了 MCP App Resource URI')

	const report = await call(financeClient, 'get_batch_review_report', {
		jobId: started.job.jobId
	})
	assert(report.job.result.total === 3, '报告 Tool 返回结构化审核数据')

	const appResource = await financeClient.readResource({ uri: appUri })
	assert(appResource.contents[0]?.mimeType === 'text/html;profile=mcp-app', 'App Resource 使用 MCP Apps MIME Type')
	assert(appResource.contents[0]?.text.includes('批量退款审核报告'), 'App Resource 返回已经构建的 HTML')

	console.log('\n全部验证通过。')
} finally {
	await Promise.allSettled([
		serviceClient?.close(),
		financeClient?.close(),
		starClient?.close()
	])
}

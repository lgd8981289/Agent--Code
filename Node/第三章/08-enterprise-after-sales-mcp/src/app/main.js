import { App } from '@modelcontextprotocol/ext-apps'

import './style.css'

// 获取报告页面中的主要 DOM 元素。
const statusElement = document.querySelector('#status')
const summaryElement = document.querySelector('#summary')
const rowsElement = document.querySelector('#rows')
const jobIdElement = document.querySelector('#job-id')

/**
 * 将单条审核结果转换成页面展示文案和样式类型。
 */
function resultLabel(item) {
	if (!item.eligible) return ['拒绝', 'danger']
	if (item.manualReview) return ['待人工审核', 'warning']
	return ['自动通过', 'success']
}

/**
 * 根据 Tool Result 渲染批量退款审核报告。
 */
function render(data) {
	const job = data?.job
	const result = job?.result

	// 任务尚未生成审核结果时，不更新页面。
	if (!result) return

	statusElement.textContent = '审核完成'
	statusElement.className = 'status completed'
	jobIdElement.textContent = job.jobId

	// 更新审核总数、自动通过、人工审核和拒绝数量。
	const values = [
		result.total,
		result.autoApproved,
		result.manualReview,
		result.rejected
	]

	summaryElement.querySelectorAll('strong').forEach((element, index) => {
		element.textContent = values[index]
	})

	// 将每一条订单审核结果渲染到表格中。
	rowsElement.innerHTML = result.details
		.map((item) => {
			const [label, tone] = resultLabel(item)

			const action = item.manualReview
				? '转人工'
				: item.eligible
					? '系统处理'
					: '终止退款'

			return `
				<tr>
					<td><strong>${item.orderId}</strong></td>
					<td><span class="result ${tone}">${label}</span></td>
					<td>${action}</td>
					<td>${item.conclusion}</td>
				</tr>`
		})
		.join('')
}

// 创建 MCP App，并监听 Host 发送过来的 Tool Result。
const app = new App(
	{
		name: 'after-sales-review-report',
		version: '1.0.0'
	},
	{}
)

app.ontoolresult = (params) => {
	render(params.structuredContent)
}

// 连接 Host，开始接收 Tool Input 和 Tool Result。
await app.connect()

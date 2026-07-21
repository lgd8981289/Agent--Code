import { App } from '@modelcontextprotocol/ext-apps'

import './style.css'

const statusElement = document.querySelector('#status')
const summaryElement = document.querySelector('#summary')
const rowsElement = document.querySelector('#rows')
const jobIdElement = document.querySelector('#job-id')

function resultLabel(item) {
	if (!item.eligible) return ['拒绝', 'danger']
	if (item.manualReview) return ['待人工审核', 'warning']
	return ['自动通过', 'success']
}

function render(data) {
	const job = data?.job
	const result = job?.result
	if (!result) return

	statusElement.textContent = '审核完成'
	statusElement.className = 'status completed'
	jobIdElement.textContent = job.jobId

	const values = [result.total, result.autoApproved, result.manualReview, result.rejected]
	summaryElement.querySelectorAll('strong').forEach((element, index) => {
		element.textContent = values[index]
	})

	rowsElement.innerHTML = result.details
		.map((item) => {
			const [label, tone] = resultLabel(item)
			const action = item.manualReview ? '转人工' : item.eligible ? '系统处理' : '终止退款'
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

const app = new App(
	{ name: 'after-sales-review-report', version: '1.0.0' },
	{}
)

app.ontoolresult = (params) => render(params.structuredContent)
await app.connect()

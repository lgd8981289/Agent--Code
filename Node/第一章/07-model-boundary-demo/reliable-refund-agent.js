const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'

// 使用本地数据模拟订单数据库。
// 真实项目中，这里应该查询数据库或者调用订单服务。
const orders = new Map([
	[
		'A1024',
		{
			orderId: 'A1024',
			refundAmount: 3000,
			status: 'refund_requested'
		}
	]
])

// 这是一条能够明确写成代码的业务规则。
// 审核结论应该由确定性代码计算，而不是交给模型猜测。
const MANUAL_REVIEW_THRESHOLD = 2000

function queryOrder(orderId) {
	return orders.get(orderId)
}

/**
 * 根据订单信息评估是否需要人工审核
 */
function evaluateRefund(order) {
	const needsManualReview = order.refundAmount > MANUAL_REVIEW_THRESHOLD

	return {
		orderId: order.orderId,
		refundAmount: order.refundAmount,
		threshold: MANUAL_REVIEW_THRESHOLD,
		needsManualReview,
		conclusion: needsManualReview ? '需要人工审核' : '无需人工审核'
	}
}

/**
 * 让模型把已经验证的结果改写成用户容易理解的回复。
 *
 * 注意：模型只负责表达。
 * result 中的业务事实和审核结论，已经由应用程序提前确定。
 */
async function generateCustomerMessage(result) {
	const response = await fetch('https://api.deepseek.com/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: 'system',
					content:
						'你负责把已经验证的退款审核结果改写成一句简洁回复。不得修改订单编号、金额、阈值和审核结论，也不得声称已经执行退款。'
				},
				{
					role: 'user',
					// {"orderId":"A1024","refundAmount":3000,"threshold":2000,"needsManualReview":true,"conclusion":"需要人工审核"}
					content: JSON.stringify(result)
				}
			],
			max_tokens: 120,
			temperature: 0.2,
			stream: false,
			thinking: {
				type: 'disabled'
			}
		})
	})

	const data = await response.json()

	return data.choices[0].message.content
}

/**
 * 审核退款申请
 */
async function reviewRefund(orderId) {
	// 第一步：应用程序查询真实订单。
	const order = queryOrder(orderId)

	// 第二步：普通代码根据业务规则计算审核结论。
	const authoritativeResult = evaluateRefund(order)

	// 第三步：模型只负责把已验证结果写成自然语言。
	const customerMessage = await generateCustomerMessage(authoritativeResult)

	return {
		authoritativeResult,
		customerMessage
	}
}

async function main() {
	// 查询 A1024 的审核结果，并让模型生成给客户的回复。
	const result = await reviewRefund('A1024')
	console.dir(result, { depth: null })
}

main()

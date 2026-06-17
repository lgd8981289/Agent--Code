const { profileTask } = require('./task-profiler')
const { routeTask, buildExecutionPlan } = require('./model-router')
const { callDeepSeek } = require('./deepseek-client')

// 准备几种不同类型的测试任务
const tasks = [
	{
		id: 'rewrite-reply',
		userText:
			'把审核结果改写成一句客服回复：订单 A1024 退款金额超过 2000 元，需要人工审核。',
		expectedOutput: 'text'
	},
	{
		id: 'amount-check',
		userText: '订单 A1024 的退款金额是 3000 元，是否超过人工审核阈值 2000 元？',
		order: {
			id: 'A1024',
			refundAmount: 3000,
			manualReviewThreshold: 2000
		},
		expectedOutput: 'decision'
	},
	{
		id: 'policy-analysis',
		userText: `
用户签收 3 天，商品不是生鲜，退款金额 3000 元。
规则 A：普通商品签收 7 天内可退款。
规则 B：生鲜不支持无理由退款。
规则 C：超过 2000 元需要人工审核。
规则 D：如果订单存在风控标记，必须进入人工复核。

请判断当前订单应该进入哪个流程，并说明依据。
`,
		expectedOutput: 'reasoned_decision'
	},
	{
		id: 'photo-check',
		userText: '这张图片里的咖啡机外壳是不是破损了？我要申请退款。',
		attachments: [
			{
				type: 'image',
				name: 'coffee-machine.jpg'
			}
		],
		expectedOutput: 'vision_decision'
	}
]

// 用普通代码执行确定性规则判断
function runDeterministicRule(task) {
	const { refundAmount, manualReviewThreshold } = task.order

	return {
		needManualReview: refundAmount > manualReviewThreshold,
		reason: `退款金额 ${refundAmount} 元，人工审核阈值 ${manualReviewThreshold} 元。`
	}
}

// 根据不同路线，组装要发送给模型的 messages
function buildMessages(task, route) {
	if (route.name === 'normal_text') {
		return [
			{
				role: 'system',
				content: '你是退款客服助手。请把业务结果改写成简洁、自然的用户回复。'
			},
			{
				role: 'user',
				content: task.userText
			}
		]
	}

	return [
		{
			role: 'system',
			content:
				'你是退款审核助手。请基于用户给出的订单信息和规则，给出结论与依据。'
		},
		{
			role: 'user',
			content: task.userText
		}
	]
}

// 执行单个任务
async function runTask(task) {
	// 先分析任务特征
	const profile = profileTask(task)

	// 根据任务特征选择执行路线
	const route = routeTask(profile)

	// 生成当前路线的执行计划
	const plan = buildExecutionPlan(profile, route)

	console.log('\n==============================')
	console.log('任务：', task.id)
	console.log('路线：', route.name)
	console.log('位置：', route.layer)
	console.log('原因：', route.reason)
	console.log('执行计划：')

	plan.forEach((step, index) => {
		console.log(`${index + 1}. ${step}`)
	})

	// 如果命中确定性规则，就直接用代码判断，不调用模型
	if (route.name === 'deterministic_code') {
		console.log('代码判断结果：')
		console.dir(runDeterministicRule(task), { depth: null })
		return
	}

	// 如果是图片任务，这里只打印多模态执行计划
	if (route.name === 'vision_plan') {
		console.log('多模态路线说明：')
		console.log(
			'当前 DeepSeek 文本接口不直接处理图片输入，这里只生成多模态执行计划。'
		)
		return
	}

	// 其他文本任务，调用 DeepSeek
	const result = await callDeepSeek({
		route,
		messages: buildMessages(task, route)
	})

	// 没有配置 API Key 时，只打印请求体
	if (result.skipped) {
		console.log(result.reason)
		console.log('DeepSeek 请求体：')
		console.dir(result.requestBody, { depth: null })
		return
	}

	// 打印模型返回结果和调用统计
	console.log('DeepSeek 返回：')
	console.log(result.content)
	console.log('调用统计：')
	console.dir(
		{
			latencyMs: result.latencyMs,
			usage: result.usage
		},
		{ depth: null }
	)
}

// 依次执行所有测试任务
async function main() {
	for (const task of tasks) {
		await runTask(task)
	}
}

main()

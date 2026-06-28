// 为了让实验结果更明显，这里故意设置一个很小的窗口。
const MODEL_CONTEXT_LIMIT = 220

// Context Window 不只容纳输入，还需要为模型回答预留空间。
const OUTPUT_RESERVE = 60

// Agent 后续还可能加入 RAG 文档、工具描述和工具结果。
const EXTERNAL_CONTEXT_RESERVE = 40

/**
 * 粗略估算文字占用的 Token。
 * 这不是任何真实模型的 Tokenizer，只用于演示预算分配流程。
 */
function estimateTextTokens(text) {
	const characters = [...text]
	const chineseCharacterCount = characters.filter((character) =>
		/\p{Script=Han}/u.test(character)
	).length
	const otherCharacterCount = characters.length - chineseCharacterCount

	return Math.ceil(chineseCharacterCount * 0.7 + otherCharacterCount / 4)
}

function estimateMessageTokens(message) {
	// role、分隔符和消息模板同样会占用 Token。
	// 这里使用固定数值模拟这部分开销。
	return estimateTextTokens(message.content) + 6
}

function estimateMessagesTokens(messages) {
	return messages.reduce(
		(total, message) => total + estimateMessageTokens(message),
		0
	)
}

/**
 * 在输入预算内，组装本次真正发送给模型的 messages。
 */
function buildContext({
	systemMessage,
	summaryMessage,
	historyTurns,
	userMessage
}) {
	// 从完整窗口中，减去输出和外部上下文预留。
	const inputBudget =
		MODEL_CONTEXT_LIMIT - OUTPUT_RESERVE - EXTERNAL_CONTEXT_RESERVE

	// 这三部分是当前任务必须保留的内容。
	const requiredMessages = [systemMessage, summaryMessage, userMessage]
	const requiredTokens = estimateMessagesTokens(requiredMessages)

	if (requiredTokens > inputBudget) {
		throw new Error('必选内容已经超过输入预算，需要继续压缩摘要或当前输入。')
	}

	let remainingBudget = inputBudget - requiredTokens
	const selectedTurns = []
	const discardedTurns = []

	// 从最近一轮开始向前选择，每次保留完整的 user + assistant。
	for (let index = historyTurns.length - 1; index >= 0; index -= 1) {
		const turn = historyTurns[index]
		const turnTokens = estimateMessagesTokens(turn)

		if (turnTokens <= remainingBudget) {
			selectedTurns.unshift(turn)
			remainingBudget -= turnTokens
		} else {
			discardedTurns.unshift(turn)
		}
	}

	const messages = [
		systemMessage,
		summaryMessage,
		...selectedTurns.flat(),
		userMessage
	]

	return {
		messages,
		selectedTurns,
		discardedTurns,
		inputBudget,
		usedInputTokens: estimateMessagesTokens(messages),
		remainingInputTokens: remainingBudget
	}
}

const systemMessage = {
	role: 'system',
	content: '你是星河零售公司的退款审核助手，只根据已提供的信息判断。'
}

// 历史摘要保留旧对话中仍然重要的事实。
// 这里直接准备摘要，后续 Memory 章节会继续学习如何生成和保存它。
const summaryMessage = {
	role: 'system',
	content:
		'历史摘要：用户正在处理订单 A1024，退款申请人为小明，退款金额为 3000 元。'
}

// 按完整对话轮次保存历史，避免只留下问题或者回答。
const historyTurns = [
	[
		{
			role: 'user',
			content: '帮我介绍一下公司的退款流程，并给出每个环节的负责人。'
		},
		{
			role: 'assistant',
			content:
				'退款流程包括提交申请、规则校验、订单核对、人工审核和原路退款。不同退款类型会进入不同处理环节。'
		}
	],
	[
		{
			role: 'user',
			content: '订单 A1024 的退款金额是 3000 元。'
		},
		{
			role: 'assistant',
			content: '已记录订单 A1024 的退款金额为 3000 元。'
		}
	],
	[
		{
			role: 'user',
			content: '退款金额超过 2000 元时，需要人工审核。'
		},
		{
			role: 'assistant',
			content: '已记录该退款审核规则。'
		}
	]
]

const userMessage = {
	role: 'user',
	content: '订单 A1024 是否需要人工审核？只回答结论和依据。'
}

// 先计算：如果什么都不删除，全部发送需要多少 Token。
const allMessages = [
	systemMessage,
	summaryMessage,
	...historyTurns.flat(),
	userMessage
]
const allMessagesTokens = estimateMessagesTokens(allMessages)

// 再根据预算，组装本次真正需要发送的内容。
const result = buildContext({
	systemMessage,
	summaryMessage,
	historyTurns,
	userMessage
})

console.log('本次 Context Budget 分配结果：')
console.table({
	模型窗口: MODEL_CONTEXT_LIMIT,
	输出预留: OUTPUT_RESERVE,
	外部上下文预留: EXTERNAL_CONTEXT_RESERVE,
	本次输入预算: result.inputBudget,
	全部发送需要Token: allMessagesTokens,
	裁剪后实际输入Token: result.usedInputTokens,
	剩余输入预算: result.remainingInputTokens,
	保留历史轮数: result.selectedTurns.length,
	移出历史轮数: result.discardedTurns.length
})

console.log('\n最终准备发送给模型的 messages：')
console.dir(result.messages, { depth: null })

console.log('\n本次没有发送的旧历史：')
console.dir(result.discardedTurns, { depth: null })

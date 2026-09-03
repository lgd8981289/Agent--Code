import {
	AIMessage,
	HumanMessage,
	trimMessages
} from '@langchain/core/messages'

/**
 * 创建本节统一使用的长对话。
 * 关键订单信息出现在最前面，中间故意加入了与当前问题无关的话题。
 */
export function createLongConversation() {
	return [
		new HumanMessage(
			'订单 A2048 是一台 3800 元的咖啡机，外壳破损。我还没有上传破损照片，客服说超过 3000 元需要人工审核。请只告诉我处理流程，不要替我提交退款。'
		),
		new AIMessage(
			'我记住了。当前订单是 A2048，金额 3800 元，还缺少破损照片，并且不要直接提交退款。'
		),
		new HumanMessage('你们周末几点营业？'),
		new AIMessage('周末客服在线时间是 9:00 到 18:00。'),
		new HumanMessage('电子发票一般多久可以开出来？'),
		new AIMessage('订单完成后通常可以在订单详情页申请电子发票。'),
		new HumanMessage('这台咖啡机签收 3 天，外包装还在。'),
		new AIMessage('收到，我会把签收时间和包装情况一起作为后续判断依据。'),
		new HumanMessage(
			'根据前面说过的情况，这笔退款要走自动流程还是人工审核？现在还缺什么材料？不要替我提交。'
		)
	]
}

/** 返回 Message 中便于展示和比较的纯文本。 */
export function messageText(message) {
	if (typeof message.content === 'string') {
		return message.content
	}

	return JSON.stringify(message.content)
}

/**
 * 估算当前输入的文本规模。
 * 这里统计字符数，不把字符数冒充精确 Token 数量。
 */
export function measureContext(messages) {
	return {
		messageCount: messages.length,
		characterCount: messages.reduce(
			(total, message) => total + messageText(message).length,
			0
		)
	}
}

/**
 * 只保留最近的几条 Message。
 * 为了让实验不依赖具体模型的 Tokenizer，这里按消息数量裁剪。
 */
export async function trimToRecentMessages(messages, keepMessages = 5) {
	return trimMessages(messages, {
		strategy: 'last',
		maxTokens: keepMessages,
		tokenCounter: (currentMessages) => currentMessages.length,
		startOn: 'human'
	})
}

/**
 * 构造“摘要 + 近期消息”的预期结果，用于和直接裁剪做确定性对比。
 * 真正的自动摘要由 automatic-compaction.js 中的 Middleware 完成。
 */
export async function createExpectedCompactedContext(messages) {
	const recentMessages = await trimToRecentMessages(messages, 5)
	const summary = new HumanMessage({
		content: `以下是较早对话的摘要：
用户咨询订单 A2048：商品是 3800 元的咖啡机，外壳破损，目前没有上传破损照片。退款金额超过 3000 元，需要人工审核。用户只要求说明流程，禁止直接提交退款。`,
		additional_kwargs: { lc_source: 'summarization' }
	})

	return [summary, ...recentMessages]
}

/** 判断一组 Message 中是否仍然包含指定关键事实。 */
export function includesFact(messages, fact) {
	return messages.some((message) => messageText(message).includes(fact))
}

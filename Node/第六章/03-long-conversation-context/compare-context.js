import {
	createExpectedCompactedContext,
	createLongConversation,
	includesFact,
	measureContext,
	messageText,
	trimToRecentMessages
} from './context.js'

/** 打印一种上下文处理方案的规模和关键事实保留情况。 */
function printStrategy(name, messages) {
	const size = measureContext(messages)

	console.log(`\n========== ${name} ==========`)
	console.table({
		消息数量: size.messageCount,
		文本字符数: size.characterCount,
		保留订单号: includesFact(messages, 'A2048'),
		保留退款金额: includesFact(messages, '3800'),
		保留缺少照片: includesFact(messages, '没有上传破损照片'),
		保留禁止提交:
			includesFact(messages, '不要替我提交') ||
			includesFact(messages, '禁止直接提交')
	})

	console.table(
		messages.map((message, index) => ({
			序号: index + 1,
			类型: message.getType(),
			内容: messageText(message).replaceAll(/\s+/g, ' ').slice(0, 110)
		}))
	)
}

/**
 * 对比三种长对话上下文处理策略：
 *
 * 1. 完整保留历史消息
 * 2. 直接裁剪，只保留近期消息
 * 3. 将早期历史压缩成摘要，再拼接近期消息
 *
 * 最后分别打印三种策略生成的上下文，
 * 便于观察它们在信息保留和上下文长度上的差异。
 */
async function main() {
	// 构造一份较长的模拟对话历史
	const fullHistory = createLongConversation()

	// 方案二：裁剪历史，只保留最近的一部分消息
	const trimmedHistory = await trimToRecentMessages(fullHistory)

	// 方案三：将较早的历史压缩为摘要，并保留近期原始消息
	const compactedHistory = await createExpectedCompactedContext(fullHistory)

	// 分别输出三种方案，方便进行直观对比
	printStrategy('方案一：完整历史', fullHistory)
	printStrategy('方案二：只保留近期消息', trimmedHistory)
	printStrategy('方案三：摘要 + 近期消息', compactedHistory)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

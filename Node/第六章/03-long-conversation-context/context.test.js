import assert from 'node:assert/strict'
import test from 'node:test'
import { SimpleChatModel } from '@langchain/core/language_models/chat_models'
import { MemorySaver } from '@langchain/langgraph'
import { createAgent, summarizationMiddleware } from 'langchain'
import {
	createExpectedCompactedContext,
	createLongConversation,
	includesFact,
	measureContext,
	messageText,
	trimToRecentMessages
} from './context.js'

class DeterministicChatModel extends SimpleChatModel {
	_llmType() {
		return 'deterministic-course-model'
	}

	bindTools() {
		return this
	}

	async _call(messages) {
		const input = messageText(messages.at(-1))

		if (input.includes('请压缩下面的对话')) {
			return '订单 A2048，金额 3800 元，缺少破损照片；只能说明流程，不能提交退款。'
		}

		return '已记录本轮信息。'
	}
}

test('直接裁剪会缩小输入，但可能丢失早期关键事实', async () => {
	const fullHistory = createLongConversation()
	const trimmedHistory = await trimToRecentMessages(fullHistory)

	assert.ok(trimmedHistory.length < fullHistory.length)
	assert.equal(includesFact(trimmedHistory, 'A2048'), false)
	assert.equal(includesFact(trimmedHistory, '3800'), false)
})

test('摘要加近期消息在缩小输入时仍保留关键事实', async () => {
	const fullHistory = createLongConversation()
	const compactedHistory = await createExpectedCompactedContext(fullHistory)

	assert.ok(
		measureContext(compactedHistory).characterCount <
			measureContext(fullHistory).characterCount
	)
	assert.equal(includesFact(compactedHistory, 'A2048'), true)
	assert.equal(includesFact(compactedHistory, '3800'), true)
	assert.equal(includesFact(compactedHistory, '没有上传破损照片'), true)
	assert.equal(includesFact(compactedHistory, '禁止直接提交'), true)
})

test('summarizationMiddleware 达到阈值后会把摘要写回 State', async () => {
	const model = new DeterministicChatModel({})
	const agent = createAgent({
		model,
		tools: [],
		checkpointer: new MemorySaver(),
		middleware: [
			summarizationMiddleware({
				model,
				trigger: { messages: 8 },
				keep: { messages: 5 },
				summaryPrefix: '较早对话摘要：',
				summaryPrompt: '请压缩下面的对话，只保留关键事实：\n{messages}'
			})
		]
	})
	const config = { configurable: { thread_id: 'summary-test' } }
	let state

	for (const index of [1, 2, 3, 4, 5]) {
		state = await agent.invoke(
			{ messages: [{ role: 'user', content: `第 ${index} 轮消息` }] },
			config
		)
	}

	const summary = state.messages.find(
		(message) => message.additional_kwargs?.lc_source === 'summarization'
	)

	assert.ok(summary)
	assert.match(messageText(summary), /订单 A2048/)
	assert.ok(state.messages.length < 10)
})

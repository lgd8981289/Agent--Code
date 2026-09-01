import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { MemorySaver } from '@langchain/langgraph'
import { createMemoryAgent, createThreadConfig } from './session.js'

test('相同 Thread 累计消息，不同 Thread 保持隔离', async () => {
	const model = new FakeListChatModel({
		responses: ['已记录第一轮信息', '已读取当前会话', '当前会话没有订单信息']
	})
	const agent = createMemoryAgent(new MemorySaver(), model)

	const firstThread = createThreadConfig('user-1001', 'support-user-1001')
	await agent.invoke(
		{ messages: [{ role: 'user', content: '第一轮信息' }] },
		firstThread
	)
	const continued = await agent.invoke(
		{ messages: [{ role: 'user', content: '继续提问' }] },
		firstThread
	)

	assert.equal(continued.messages.length, 4)

	const secondThread = createThreadConfig('user-1002', 'support-user-1002')
	const isolated = await agent.invoke(
		{ messages: [{ role: 'user', content: '另一个会话' }] },
		secondThread
	)

	assert.equal(isolated.messages.length, 2)
})

test('已知 thread_id 也不能越过会话归属校验', () => {
	assert.throws(
		() => createThreadConfig('user-1002', 'support-user-1001'),
		/无权访问/
	)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { createMemoryAgent, createThreadConfig } from './session.js'

const POSTGRES_URI =
	process.env.POSTGRES_URI ??
	'postgresql://agent_course:agent_course@localhost:5432/agent_memory'
const THREAD_ID = 'support-postgres-1001'

test('新的 Checkpointer 实例能够恢复 PostgreSQL 中的 Thread State', async () => {
	const config = createThreadConfig('user-1001', THREAD_ID)
	const firstCheckpointer = PostgresSaver.fromConnString(POSTGRES_URI)

	try {
		await firstCheckpointer.setup()
		await firstCheckpointer.deleteThread(THREAD_ID)

		const firstAgent = createMemoryAgent(
			firstCheckpointer,
			new FakeListChatModel({ responses: ['已记录订单材料'] })
		)

		await firstAgent.invoke(
			{ messages: [{ role: 'user', content: '第一轮订单信息' }] },
			config
		)
	} finally {
		await firstCheckpointer.end()
	}

	const secondCheckpointer = PostgresSaver.fromConnString(POSTGRES_URI)

	try {
		await secondCheckpointer.setup()
		const secondAgent = createMemoryAgent(
			secondCheckpointer,
			new FakeListChatModel({ responses: ['已使用恢复的会话'] })
		)

		const restored = await secondAgent.getState(config)
		assert.equal(restored.values.messages.length, 2)

		const continued = await secondAgent.invoke(
			{ messages: [{ role: 'user', content: '第二轮追问' }] },
			config
		)

		assert.equal(continued.messages.length, 4)
		await secondCheckpointer.deleteThread(THREAD_ID)
	} finally {
		await secondCheckpointer.end()
	}
})

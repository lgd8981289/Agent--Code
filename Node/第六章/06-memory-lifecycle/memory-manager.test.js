import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryStore } from '@langchain/langgraph'
import { candidates, principal } from './scenarios.js'
import {
	applyMemoryCandidate,
	forgetMemory,
	getActiveMemory,
	memoryNamespace,
	recallMemories
} from './memory-manager.js'

const now = new Date('2026-09-06T12:00:00+08:00')
const options = { now }

async function seed() {
	const store = new InMemoryStore()
	await applyMemoryCandidate(store, principal, candidates.initial, options)
	return store
}

test('相同偏好的别名和重复处理不会创建新条目或增加版本', async () => {
	const store = await seed()
	for (const candidate of [candidates.initial, candidates.repeat]) {
		const result = await applyMemoryCandidate(store, principal, candidate, options)
		assert.equal(result.action, 'duplicate')
	}
	const items = await store.search(memoryNamespace(principal))
	assert.equal(items.length, 1)
	assert.equal(items[0].value.revision, 1)
})

test('本轮 Python 要求不覆盖长期 Node.js 偏好', async () => {
	const store = await seed()
	assert.equal((await applyMemoryCandidate(store, principal, candidates.temporary, options)).action, 'current_thread_only')
	assert.equal((await getActiveMemory(store, principal, 'preferred_runtime', now)).value, 'Node.js')
})

test('冲突保持旧值，确认以后同一个 Key 更新为新值；其他字段保留', async () => {
	const store = await seed()
	await applyMemoryCandidate(store, principal, candidates.language, options)
	const conflict = await applyMemoryCandidate(store, principal, candidates.correction, options)
	assert.equal(conflict.action, 'needs_confirmation')
	assert.equal((await getActiveMemory(store, principal, 'preferred_runtime', now)).value, 'Node.js')
	await applyMemoryCandidate(store, principal, candidates.correction, { now, confirmedRevision: conflict.currentRevision })
	const memories = await recallMemories(store, principal, now)
	assert.deepEqual(memories.map(({ key, value, revision }) => ({ key, value, revision })), [
		{ key: 'preferred_language', value: 'TypeScript', revision: 1 },
		{ key: 'preferred_runtime', value: 'Python', revision: 2 }
	])
})

test('旧消息晚到不能覆盖已纠正的记忆，过时确认不能再次写入', async () => {
	const store = await seed()
	await applyMemoryCandidate(store, principal, candidates.correction, { now, confirmedRevision: 1 })
	assert.equal((await applyMemoryCandidate(store, principal, candidates.repeat, options)).action, 'stale_source')
	assert.equal((await applyMemoryCandidate(store, principal, candidates.correction, { now, confirmedRevision: 1 })).action, 'stale_confirmation')
	assert.equal((await getActiveMemory(store, principal, 'preferred_runtime', now)).value, 'Python')
})

test('在有效期边界立即停止返回，Store 物理记录暂时保留', async () => {
	const store = new InMemoryStore()
	await applyMemoryCandidate(store, principal, candidates.contact, options)
	const expiry = new Date(candidates.contact.expiresAt)
	assert.ok(await getActiveMemory(store, principal, 'contact_window', new Date(expiry.getTime() - 1)))
	assert.equal(await getActiveMemory(store, principal, 'contact_window', expiry), null)
	assert.ok(await store.get(memoryNamespace(principal), 'contact_window'))
	assert.deepEqual(await recallMemories(store, principal, expiry), [])
	assert.equal((await applyMemoryCandidate(store, principal, candidates.contact, { now: expiry })).action, 'expired_candidate')
})

test('重复消息不会自动延长有效期，延长有效期也需要确认', async () => {
	const store = new InMemoryStore()
	await applyMemoryCandidate(store, principal, candidates.contact, options)
	const extension = {
		...candidates.contact,
		expiresAt: '2026-09-10T00:00:00+08:00',
		source: { ...candidates.contact.source, messageId: 'msg-6', observedAt: '2026-09-06T10:00:00+08:00' }
	}
	assert.equal((await applyMemoryCandidate(store, principal, extension, options)).action, 'needs_confirmation')
	assert.equal((await getActiveMemory(store, principal, 'contact_window', now)).expiresAt, candidates.contact.expiresAt)
})

test('删除清除正文，旧候选和后续自动提取都被阻止，其他偏好不受影响', async () => {
	const store = await seed()
	await applyMemoryCandidate(store, principal, candidates.language, options)
	await forgetMemory(store, principal, 'preferred_runtime', now)
	assert.equal(await store.get(memoryNamespace(principal), 'preferred_runtime'), null)
	const block = await store.get(memoryNamespace(principal, 'lifecycle-blocks'), 'preferred_runtime')
	assert.deepEqual(block.value, { blockedAt: now.toISOString() })
	for (const candidate of [candidates.initial, candidates.correction]) {
		assert.equal((await applyMemoryCandidate(store, principal, candidate, options)).action, 'blocked_by_deletion')
	}
	assert.equal(await getActiveMemory(store, principal, 'preferred_runtime', now), null)
	assert.equal((await recallMemories(store, principal, now)).length, 1)
})

test('物理删除失败时已经禁止正常读写，重试删除可完成清理', async () => {
	const store = await seed()
	const originalDelete = store.delete.bind(store)
	store.delete = async () => { throw new Error('模拟存储异常') }
	await assert.rejects(forgetMemory(store, principal, 'preferred_runtime', now), /模拟存储异常/)
	assert.equal(await getActiveMemory(store, principal, 'preferred_runtime', now), null)
	assert.equal((await applyMemoryCandidate(store, principal, candidates.repeat, options)).action, 'blocked_by_deletion')
	store.delete = originalDelete
	await forgetMemory(store, principal, 'preferred_runtime', now)
	assert.equal(await store.get(memoryNamespace(principal), 'preferred_runtime'), null)
})

test('同用户不同租户、同租户不同用户的记忆和删除标记互不影响', async () => {
	const store = await seed()
	for (const other of [
		{ ...principal, userId: 'user-1002' },
		{ ...principal, tenantId: 'xinghe' }
	]) {
		assert.deepEqual(await recallMemories(store, other, now), [])
		await applyMemoryCandidate(store, other, candidates.initial, options)
	}
	await forgetMemory(store, principal, 'preferred_runtime', now)
	assert.equal((await getActiveMemory(store, { ...principal, tenantId: 'xinghe' }, 'preferred_runtime', now)).value, 'Node.js')
})

test('拒绝未知记忆字段和无效来源时间', async () => {
	const store = new InMemoryStore()
	await assert.rejects(applyMemoryCandidate(store, principal, { ...candidates.initial, key: 'company_refund_threshold' }, options))
	await assert.rejects(applyMemoryCandidate(store, principal, {
		...candidates.initial,
		source: { ...candidates.initial.source, observedAt: '2027-01-01T00:00:00Z' }
	}, options), /来源消息时间/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryStore } from '@langchain/langgraph'
import {
	loadUserProfile,
	profileNamespace,
	saveUserProfile
} from './profile-store.js'

const owner = { tenantId: 'bluewhale', userId: 'user-1001' }

test('Namespace 不包含 threadId，同一用户可以跨 Thread 读取画像', async () => {
	assert.deepEqual(profileNamespace(owner), [
		'agent-course',
		'tenants',
		'bluewhale',
		'users',
		'user-1001',
		'profiles'
	])

	const store = new InMemoryStore()
	await saveUserProfile(store, owner, {
		responseLanguage: 'zh-CN',
		answerStyle: 'conclusion_first',
		contactWindow: '工作日 19:00 以后'
	})

	const profile = await loadUserProfile(store, owner)
	assert.equal(profile.responseLanguage, 'zh-CN')
	assert.equal(profile.answerStyle, 'conclusion_first')
})

test('不同用户或不同租户使用不同 Namespace', async () => {
	const store = new InMemoryStore()
	await saveUserProfile(store, owner, {
		responseLanguage: 'zh-CN',
		answerStyle: 'conclusion_first',
		contactWindow: '工作日 19:00 以后'
	})

	assert.equal(
		await loadUserProfile(store, {
			tenantId: 'bluewhale',
			userId: 'user-1002'
		}),
		null
	)
	assert.equal(
		await loadUserProfile(store, {
			tenantId: 'star-retail',
			userId: 'user-1001'
		}),
		null
	)
})

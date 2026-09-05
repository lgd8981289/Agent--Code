import assert from 'node:assert/strict'
import test from 'node:test'
import { conversation, replayCandidates } from './conversation.js'
import {
	reviewMemoryCandidate,
	reviewMemoryCandidates
} from './memory-policy.js'

test('只接受来自用户、适合长期保存并且不敏感的候选', () => {
	const reviews = reviewMemoryCandidates(
		replayCandidates,
		conversation,
		{ memoryEnabled: true }
	)

	assert.deepEqual(
		reviews.map(({ decision }) => decision.code),
		[
			'ACCEPTED',
			'UNTRUSTED_SOURCE',
			'NOT_LONG_TERM',
			'NOT_LONG_TERM',
			'SENSITIVE_DATA'
		]
	)
})

test('没有开启长期记忆时，候选不能写入', () => {
	const decision = reviewMemoryCandidate(
		replayCandidates[0],
		conversation,
		{ memoryEnabled: false }
	)

	assert.equal(decision.accepted, false)
	assert.equal(decision.code, 'MEMORY_DISABLED')
})

test('模型给出的原文证据必须真实存在于来源消息中', () => {
	const decision = reviewMemoryCandidate(
		{
			...replayCandidates[0],
			evidenceQuote: '用户明确表示自己精通 Java'
		},
		conversation,
		{ memoryEnabled: true }
	)

	assert.equal(decision.accepted, false)
	assert.equal(decision.code, 'MISSING_EVIDENCE')
})

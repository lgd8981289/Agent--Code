import assert from 'node:assert/strict'
import test from 'node:test'
import { now, principal, scenarios } from './fixtures.js'
import { createAgenticRagGraph } from './workflow.js'

const fakeServices = {
	async decide(question) {
		if (question.includes('改写')) {
			return {
				route: 'direct',
				requiredEvidence: [],
				clarificationQuestion: null,
				reason: '文字改写不需要企业资料'
			}
		}
		if (question.includes('需要人工审核吗') && !question.includes('3500')) {
			return {
				route: 'clarify',
				requiredEvidence: [],
				clarificationQuestion: '请补充本次申请退款的金额。',
				reason: '缺少退款金额'
			}
		}
		if (question.includes('终身免费')) {
			return {
				route: 'retrieve',
				requiredEvidence: ['maintenance_policy'],
				clarificationQuestion: null,
				reason: '需要查询当前保养政策'
			}
		}
		if (question.includes('准备材料')) {
			return {
				route: 'retrieve',
				requiredEvidence: ['review_rule', 'material_requirement'],
				clarificationQuestion: null,
				reason: '需要审核规则和材料要求两类证据'
			}
		}
		return {
			route: 'retrieve',
			requiredEvidence: ['review_rule'],
			clarificationQuestion: null,
			reason: '需要当前退款审核规则'
		}
	},
	async direct() {
		return '麻烦您尽快处理这笔退款，谢谢。'
	},
	async answer({ evidence }) {
		return {
			answer: '根据当前有效资料生成的测试答案。',
			sourceIds: evidence.map((chunk) => chunk.id)
		}
	}
}

async function run(name) {
	const graph = createAgenticRagGraph({
		services: fakeServices,
		principal,
		now,
		maxSearches: 3
	})
	return graph.invoke({ question: scenarios[name].question })
}

test('普通文字任务不检索知识库', async () => {
	const result = await run('direct')
	assert.equal(result.outcome, 'direct')
	assert.equal(result.searchAttempts, 0)
	assert.deepEqual(result.sourceIds, [])
})

test('只需要一种证据时检索一次并生成答案', async () => {
	const result = await run('single')
	assert.equal(result.outcome, 'answered')
	assert.equal(result.searchAttempts, 1)
	assert.deepEqual(result.sourceIds, ['KB-REFUND-REVIEW-V3'])
})

test('问题需要两类证据时会在第一次判断后继续补查', async () => {
	const result = await run('multi')
	assert.equal(result.outcome, 'answered')
	assert.equal(result.searchAttempts, 2)
	assert.deepEqual(
		new Set(result.sourceIds),
		new Set(['KB-REFUND-REVIEW-V3', 'KB-REFUND-MATERIAL-V2'])
	)
	assert.ok(result.trace.some((line) => line.includes('仍缺少 material_requirement')))
})

test('缺少用户条件时先澄清，不进行无效检索', async () => {
	const result = await run('clarify')
	assert.equal(result.outcome, 'clarify')
	assert.equal(result.searchAttempts, 0)
	assert.match(result.finalAnswer, /退款.*金额/)
})

test('只有停用资料时拒绝回答，不引用旧版本', async () => {
	const result = await run('unknown')
	assert.equal(result.outcome, 'refused')
	assert.equal(result.searchAttempts, 1)
	assert.deepEqual(result.sourceIds, [])
	assert.deepEqual(result.rejectedEvidence, [
		{ id: 'KB-MAINTENANCE-OLD', reason: '文档已经停用或被新版本替代' }
	])
})

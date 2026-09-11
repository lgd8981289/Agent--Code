import { describe, expect, it } from 'vitest'
import { InterviewKnowledgeService } from './knowledge.service.js'
import { InterviewModelService } from './model.service.js'

const profile = {
	experience: '3 年前端开发',
	targetRole: 'AI 应用开发工程师',
	focusTopics: ['Agent Memory'],
	answerStyle: '简洁'
}

describe('InterviewModelService Replay 模式', () => {
	const models = new InterviewModelService()

	it('能识别不完整回答和完整回答', async () => {
		const question = models.selectQuestion({
			profile,
			reviewMemory: null,
			turnNumber: 0,
			previousQuestion: null,
			previousEvaluation: null
		})

		const weak = await models.evaluate('replay', question, '它们都是保存聊天记录的。')
		const complete = await models.evaluate(
			'replay',
			question,
			'Checkpointer 根据 thread_id 保存 State，Store 保存跨会话长期记忆。'
		)

		expect(weak.verdict).toBe('incorrect')
		expect(complete.verdict).toBe('correct')
	})

	it('会在回答不完整时生成追问', () => {
		const first = models.selectQuestion({
			profile,
			reviewMemory: null,
			turnNumber: 0,
			previousQuestion: null,
			previousEvaluation: null
		})
		const followUp = models.selectQuestion({
			profile,
			reviewMemory: null,
			turnNumber: 1,
			previousQuestion: first,
			previousEvaluation: {
				verdict: 'partial',
				reason: '不完整',
				gaps: ['Store'],
				requiredEvidence: first.evidenceTypes
			}
		})

		expect(followUp.id).toBe('memory-boundaries-followup')
	})
})

describe('InterviewKnowledgeService', () => {
	it('一次只返回指定类型的反馈依据', () => {
		const knowledge = new InterviewKnowledgeService()
		const result = knowledge.search('long_term_memory')

		expect(result).toHaveLength(1)
		expect(result[0].id).toBe('LC-LONG-TERM-MEMORY')
	})
})

import { Injectable } from '@nestjs/common'
import { ChatDeepSeek } from '@langchain/deepseek'
import * as z from 'zod'
import type {
	EvaluationResult,
	FeedbackResult,
	InterviewProfile,
	InterviewQuestion,
	KnowledgeSource,
	LearningMemory,
	SessionMode
} from './interview.types.js'

const questionBank: InterviewQuestion[] = [
	{
		id: 'memory-boundaries',
		topic: 'agent-memory',
		title: '短期记忆与长期记忆',
		prompt:
			'在 LangGraph 中，Checkpointer 和 Store 有什么区别？如果希望用户换一个 Thread 后仍能复习薄弱知识点，应该保存在哪里？',
		expectedPoints: [
			'Checkpointer 按 thread_id 保存当前 Thread 的 Agent State',
			'Store 使用自定义 Namespace 保存跨 Thread 的长期信息',
			'跨会话复习的薄弱点应该保存在 Store 中'
		],
		evidenceTypes: ['short_term_memory', 'long_term_memory'],
		followUpPrompt:
			'同一名用户关闭页面后继续原面试，以及新建一场复习面试，分别应该从 Checkpointer 和 Store 中读取什么？'
	},
	{
		id: 'agentic-rag',
		topic: 'agentic-rag',
		title: 'Agentic RAG',
		prompt:
			'普通 RAG 和 Agentic RAG 的主要区别是什么？什么情况下 Agent 需要进行第二轮检索？',
		expectedPoints: [
			'普通 RAG 的检索流程通常由程序预先固定',
			'Agentic RAG 会根据任务决定是否检索和检索什么',
			'必要证据缺失时才继续补查，并且需要检索预算'
		],
		evidenceTypes: ['agentic_rag'],
		followUpPrompt:
			'如果第一轮只找到人工审核阈值，却没有找到材料要求，Agent 接下来应该怎样处理？'
	},
	{
		id: 'tool-calling',
		topic: 'tool-calling',
		title: 'Tool Calling',
		prompt: '模型返回 Tool Call 以后，为什么不能认为工具已经执行完成？',
		expectedPoints: [
			'模型只提出工具名称和参数',
			'应用程序负责校验和执行',
			'工具结果需要回传给模型继续处理'
		],
		evidenceTypes: ['tool_calling'],
		followUpPrompt:
			'如果 Tool Call 中的订单号不存在，应用程序应该把什么结果回传给模型？'
	},
	{
		id: 'context-budget',
		topic: 'context-budget',
		title: 'Context Budget',
		prompt: '长对话中，应用程序为什么需要主动管理 Context Budget？',
		expectedPoints: [
			'上下文窗口存在上限',
			'输入 Token 会影响成本和延迟',
			'应该优先保留完成当前任务需要的信息'
		],
		evidenceTypes: ['context_budget'],
		followUpPrompt:
			'当历史消息超过预算时，哪些信息应该优先保留，哪些内容可以被裁剪或摘要？'
	}
]

const EvaluationSchema = z.object({
	verdict: z.enum(['correct', 'partial', 'incorrect']),
	reason: z.string(),
	gaps: z.array(z.string()),
	requiredEvidence: z.array(z.string())
})

const FeedbackSchema = z.object({
	content: z.string(),
	sourceIds: z.array(z.string())
})

function containsAny(answer: string, words: string[]) {
	const normalized = answer.toLowerCase()
	return words.some((word) => normalized.includes(word.toLowerCase()))
}

function createReplayEvaluation(
	question: InterviewQuestion,
	answer: string
): EvaluationResult {
	const rules: Record<string, string[][]> = {
		'agent-memory': [
			['thread', 'thread_id', '会话'],
			['store', '跨会话', '长期记忆'],
			['checkpointer', 'state', '状态']
		],
		'agentic-rag': [
			['是否检索', '按需', '自主'],
			['证据', '缺少', '不足'],
			['补查', '第二轮', '多轮']
		],
		'tool-calling': [
			['模型', '提出', '生成'],
			['应用', '程序', '执行'],
			['回传', 'tool result', 'toolmessage']
		],
		'context-budget': [
			['上限', '窗口'],
			['token', '成本', '延迟'],
			['保留', '裁剪', '摘要']
		]
	}
	const matched = (rules[question.topic] ?? []).filter((group) =>
		containsAny(answer, group)
	).length
	const verdict = matched >= 3 ? 'correct' : matched >= 1 ? 'partial' : 'incorrect'
	const gaps = question.expectedPoints.slice(matched)

	return {
		verdict,
		reason:
			verdict === 'correct'
				? '回答覆盖了这道题的核心边界。'
				: '已经提到部分相关概念，但关键区别还没有说完整。',
		gaps,
		requiredEvidence: question.evidenceTypes
	}
}

/** 封装确定性演示与真实 DeepSeek 两种面试能力。 */
@Injectable()
export class InterviewModelService {
	private createModel() {
		if (!process.env.DEEPSEEK_API_KEY) {
			throw new Error('当前未配置 DEEPSEEK_API_KEY，请使用 Replay 模式。')
		}

		return new ChatDeepSeek({
			model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
			temperature: 0,
			maxRetries: 2,
			timeout: 60000,
			modelKwargs: { thinking: { type: 'disabled' } }
		})
	}

	hasAiMode() {
		return Boolean(process.env.DEEPSEEK_API_KEY)
	}

	selectQuestion(input: {
		profile: InterviewProfile
		reviewMemory: LearningMemory | null
		turnNumber: number
		previousQuestion: InterviewQuestion | null
		previousEvaluation: EvaluationResult | null
	}) {
		if (
			input.previousQuestion &&
			input.previousEvaluation?.verdict !== 'correct' &&
			!input.previousQuestion.id.endsWith('-followup')
		) {
			return {
				...input.previousQuestion,
				id: `${input.previousQuestion.id}-followup`,
				prompt: input.previousQuestion.followUpPrompt
			}
		}

		if (input.reviewMemory) {
			const reviewed = questionBank.find(
				(question) => question.topic === input.reviewMemory?.topic
			)
			if (reviewed) {
				return {
					...reviewed,
					id: `${reviewed.id}-review`,
					prompt: `上次你在「${reviewed.title}」上留下了薄弱记录。这次换一个场景：${reviewed.followUpPrompt}`
				}
			}
		}

		const topicText = input.profile.focusTopics.join(' ').toLowerCase()
		const preferredIndex = topicText.includes('memory') ? 0 : 1
		return questionBank[(preferredIndex + input.turnNumber) % questionBank.length]
	}

	async evaluate(
		mode: SessionMode,
		question: InterviewQuestion,
		answer: string
	): Promise<EvaluationResult> {
		if (mode === 'replay') return createReplayEvaluation(question, answer)

		const evaluator = this.createModel().withStructuredOutput(EvaluationSchema, {
			name: 'evaluate_interview_answer'
		})
		const result = await evaluator.invoke([
			{
				role: 'system',
				content:
					'你是 AI 应用开发岗位的面试官。严格对照 expectedPoints 评估回答，不要因为候选人提到相关名词就判定正确。requiredEvidence 只能从题目提供的 evidenceTypes 中选择。'
			},
			{
				role: 'user',
				content: JSON.stringify({ question, answer }, null, 2)
			}
		])
		const requiredEvidence = result.requiredEvidence.filter((type) =>
			question.evidenceTypes.includes(type)
		)

		return {
			...result,
			requiredEvidence:
				requiredEvidence.length > 0 ? requiredEvidence : question.evidenceTypes
		}
	}

	async composeFeedback(input: {
		mode: SessionMode
		question: InterviewQuestion
		answer: string
		evaluation: EvaluationResult
		evidence: KnowledgeSource[]
	}): Promise<FeedbackResult> {
		if (input.mode === 'replay') {
			const missing = input.evaluation.gaps.length
				? `\n\n还需要补充：${input.evaluation.gaps.join('；')}。`
				: ''
			return {
				content: `${input.evaluation.reason}${missing}\n\n一个完整回答应该包含：${input.question.expectedPoints.join('；')}。`,
				sourceIds: input.evidence.map((source) => source.id)
			}
		}

		const writer = this.createModel().withStructuredOutput(FeedbackSchema, {
			name: 'compose_grounded_feedback'
		})
		const response = await writer.invoke([
			{
				role: 'system',
				content:
					'根据评估结果和已检索的资料，给候选人一段直接、可执行的面试反馈。sourceIds 只能填写输入中真实存在的资料 ID。'
			},
			{ role: 'user', content: JSON.stringify(input, null, 2) }
		])

		const allowedIds = new Set(input.evidence.map((source) => source.id))
		return {
			content: response.content,
			sourceIds: response.sourceIds.filter((id) => allowedIds.has(id))
		}
	}
}

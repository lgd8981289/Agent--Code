import { Inject, Injectable } from '@nestjs/common'
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph'
import * as z from 'zod'
import type { Principal } from '../auth/auth.types.js'
import { StorageService } from '../storage/storage.service.js'
import { InterviewKnowledgeService } from './knowledge.service.js'
import { InterviewMemoryService } from './memory.service.js'
import { InterviewModelService } from './model.service.js'
import type {
	EvaluationResult,
	FeedbackResult,
	InterviewMessage,
	InterviewProfile,
	InterviewQuestion,
	InterviewStateView,
	KnowledgeSource,
	SessionKind,
	SessionMode,
	SessionStatus
} from './interview.types.js'

const InterviewState = new StateSchema({
	event: z.enum(['start', 'answer', 'next']).default('start'),
	sessionId: z.string(),
	mode: z.enum(['replay', 'ai']),
	kind: z.enum(['new', 'review']),
	status: z
		.enum(['awaiting_answer', 'turn_complete'])
		.default('awaiting_answer'),
	profile: z.custom<InterviewProfile>(),
	messages: z.array(z.custom<InterviewMessage>()).default(() => []),
	currentQuestion: z.custom<InterviewQuestion>().nullable().default(null),
	answer: z.string().default(''),
	lastEvaluation: z.custom<EvaluationResult>().nullable().default(null),
	lastFeedback: z.custom<FeedbackResult>().nullable().default(null),
	requiredEvidence: z.array(z.string()).default(() => []),
	missingEvidence: z.array(z.string()).default(() => []),
	evidence: z.array(z.custom<KnowledgeSource>()).default(() => []),
	usedMemoryKeys: z.array(z.string()).default(() => []),
	struggledTopics: z.array(z.string()).default(() => []),
	turnNumber: z.number().int().nonnegative().default(0),
	trace: z.array(z.string()).default(() => [])
})

type GraphState = typeof InterviewState.State

function message(
	role: InterviewMessage['role'],
	kind: InterviewMessage['kind'],
	content: string
): InterviewMessage {
	return {
		id: crypto.randomUUID(),
		role,
		kind,
		content,
		createdAt: new Date().toISOString()
	}
}

function appendUnique<T>(
	items: T[],
	additions: T[],
	getKey: (item: T) => string
) {
	const result = [...items]
	const keys = new Set(items.map(getKey))
	for (const item of additions) {
		const key = getKey(item)
		if (!keys.has(key)) {
			keys.add(key)
			result.push(item)
		}
	}
	return result
}

/** 将一场面试组装成可恢复、可补查证据的 LangGraph。 */
@Injectable()
export class InterviewGraphService {
	constructor(
		@Inject(StorageService) private readonly storage: StorageService,
		@Inject(InterviewMemoryService)
		private readonly memories: InterviewMemoryService,
		@Inject(InterviewKnowledgeService)
		private readonly knowledge: InterviewKnowledgeService,
		@Inject(InterviewModelService)
		private readonly models: InterviewModelService
	) {}

	private createGraph(principal: Principal) {
		const dispatch = () => ({})

		/**
		 * 根据当前事件决定下一步执行哪个节点。
		 *
		 * - answer：说明用户提交了答案，进入答案评估流程
		 * - 其他事件：默认进入出题流程
		 */
		const routeEvent = (state: GraphState) => {
			if (state.event === 'answer') {
				return 'evaluate_answer'
			}
			return 'prepare_question'
		}

		/**
		 * Node：准备本轮面试题。
		 *
		 * 普通训练直接根据当前上下文选择题目；
		 * review 模式会额外读取长期记忆中的薄弱点，用于生成复测题。
		 *
		 * 出题完成后：
		 * - 保存新的 currentQuestion
		 * - 清空上一轮回答、评估和证据
		 * - 将会话状态切换为 awaiting_answer
		 * - 记录本轮使用到的长期记忆
		 */
		const prepareQuestion = async (state: GraphState) => {
			/**
			 * 只有 review 模式才需要读取长期记忆。
			 *
			 * 普通训练不依赖历史薄弱点，因此直接返回 null。
			 */
			const reviewMemory =
				state.kind === 'review'
					? await this.memories.getReviewMemory(principal)
					: null

			/**
			 * 根据当前训练上下文选择下一道题。
			 *
			 * 这里会综合：
			 * - 用户画像
			 * - review 模式下召回的长期记忆
			 * - 当前轮次
			 * - 上一题及其评估结果
			 *
			 * 从而避免简单地随机出题。
			 */
			const question = this.models.selectQuestion({
				profile: state.profile,
				reviewMemory,
				turnNumber: state.turnNumber,
				previousQuestion: state.currentQuestion,
				previousEvaluation: state.lastEvaluation
			})

			return {
				// 已经完成出题，等待用户提交答案
				status: 'awaiting_answer' as SessionStatus,

				// 保存本轮需要回答的新题目
				currentQuestion: question,

				/**
				 * 新一轮开始后，清空上一轮产生的临时状态，
				 * 避免旧答案、评估结果和 RAG 证据影响当前题目。
				 */
				answer: '',
				lastEvaluation: null,
				lastFeedback: null,
				requiredEvidence: [],
				missingEvidence: [],
				evidence: [],

				/**
				 * 如果本轮题目使用了长期记忆，
				 * 记录对应 Memory Key，方便后续追踪题目生成依据。
				 */
				usedMemoryKeys: reviewMemory ? [reviewMemory.key] : [],

				// 将新的面试题追加到会话消息历史
				messages: [
					...state.messages,
					message('assistant', 'question', question.prompt)
				],

				// 记录本次出题过程，方便调试和观察 Graph 执行链路
				trace: [
					...state.trace,
					reviewMemory
						? `prepare_question：根据长期记忆 ${reviewMemory.key} 生成复测题`
						: `prepare_question：生成 ${question.title} 面试题`
				]
			}
		}

		/**
		 * Node：评估用户对当前面试题的回答。
		 *
		 * 主要职责：
		 * 1. 校验当前题目和回答是否存在
		 * 2. 调用模型评估回答质量
		 * 3. 记录用户薄弱的知识点
		 * 4. 初始化后续反馈阶段需要补充的证据
		 * 5. 将本次回答写入消息历史和执行 Trace
		 */
		const evaluateAnswer = async (state: GraphState) => {
			// 当前必须存在一道正在回答的题目
			if (!state.currentQuestion) {
				throw new Error('当前会话中没有待回答的题目。')
			}

			// 防止空回答进入模型评估流程
			if (!state.answer.trim()) {
				throw new Error('面试回答不能为空。')
			}

			// 调用模型对当前回答进行评估，
			// 返回 verdict、requiredEvidence 等后续反馈阶段需要的信息
			const evaluation = await this.models.evaluate(
				state.mode,
				state.currentQuestion,
				state.answer
			)

			// 如果回答正确，则保持原有薄弱知识点不变；
			// 如果回答存在问题，则将当前题目的 topic 记录为薄弱知识点
			const struggledTopics =
				evaluation.verdict === 'correct'
					? state.struggledTopics
					: appendUnique(
							state.struggledTopics,
							[state.currentQuestion.topic],
							(topic) => topic
						)

			return {
				// 保存本次回答的模型评估结果
				lastEvaluation: evaluation,

				// 记录生成反馈时需要哪些类型的证据
				requiredEvidence: evaluation.requiredEvidence,

				// 初始状态下，所有需要的证据都还没有获取
				missingEvidence: evaluation.requiredEvidence,

				// 清空上一轮证据，准备进入本轮证据检索流程
				evidence: [],

				// 更新用户当前累计的薄弱知识点
				struggledTopics,

				// 将用户本次回答追加到会话消息历史
				messages: [...state.messages, message('user', 'answer', state.answer)],

				// 记录当前节点的执行结果，方便后续调试和观察 Graph 执行链路
				trace: [
					...state.trace,
					`evaluate_answer：${evaluation.verdict}，需要 ${evaluation.requiredEvidence.length} 类反馈依据`
				]
			}
		}

		const routeAfterEvaluation = (state: GraphState) =>
			state.missingEvidence.length > 0
				? 'retrieve_evidence'
				: 'compose_feedback'

		/**
		 * 根据当前缺失的证据类型，从知识库中补查对应资料。
		 *
		 * 每次只处理一个 evidenceType：
		 * 补查完成后，后续节点会重新判断是否还存在缺失证据，
		 * 从而形成「判断 → 检索 → 再判断」的循环。
		 */
		const retrieveEvidence = (state: GraphState) => {
			// 取出当前优先需要补查的证据类型
			const evidenceType = state.missingEvidence[0]

			console.log('state.missingEvidence[0]', state.missingEvidence[0])

			if (!evidenceType) {
				throw new Error('没有找到本轮需要补查的证据类型。')
			}

			// 根据证据类型查询知识库，返回对应的候选资料
			const found = this.knowledge.search(evidenceType)

			return {
				// 将本轮检索结果合并到已有证据中，
				// 并按照 source.id 去重，避免多轮补查产生重复资料
				evidence: appendUnique(state.evidence, found, (source) => source.id),

				// 记录本轮实际查询的证据类型和返回数量，
				// 便于观察 Agent 的多轮补查过程
				trace: [
					...state.trace,
					`retrieve_evidence：${evidenceType} 返回 ${found.length} 条资料`
				]
			}
		}

		const assessEvidence = (state: GraphState) => {
			const foundTypes = new Set(
				state.evidence.map((item) => item.evidenceType)
			)
			const missingEvidence = state.requiredEvidence.filter(
				(type) => !foundTypes.has(type)
			)

			return {
				missingEvidence,
				trace: [
					...state.trace,
					missingEvidence.length
						? `assess_evidence：仍缺少 ${missingEvidence.join('、')}`
						: 'assess_evidence：反馈依据已经齐全'
				]
			}
		}

		const routeAfterAssessment = (state: GraphState) =>
			state.missingEvidence.length > 0
				? 'retrieve_evidence'
				: 'compose_feedback'

		const composeFeedback = async (state: GraphState) => {
			if (!state.currentQuestion || !state.lastEvaluation) {
				throw new Error('缺少面试题或评估结果。')
			}
			const feedback = await this.models.composeFeedback({
				mode: state.mode,
				question: state.currentQuestion,
				answer: state.answer,
				evaluation: state.lastEvaluation,
				evidence: state.evidence
			})

			return {
				status: 'turn_complete' as SessionStatus,
				lastFeedback: feedback,
				turnNumber: state.turnNumber + 1,
				messages: [
					...state.messages,
					message('assistant', 'feedback', feedback.content)
				],
				trace: [
					...state.trace,
					`compose_feedback：绑定 ${feedback.sourceIds.length} 条真实来源`
				]
			}
		}

		/**
		 * Node：将本次答题结果写入训练记忆。
		 *
		 * 只有当前题目、评估结果和反馈结果都存在时才允许保存。
		 * 保存内容包括题目、回答结果、引用来源以及当前知识点是否属于薄弱项。
		 */
		const saveTrainingMemory = async (state: GraphState) => {
			// 保存记忆前必须已经完成：题目生成 → 回答评估 → 反馈生成
			if (
				!state.currentQuestion ||
				!state.lastEvaluation ||
				!state.lastFeedback
			) {
				throw new Error('缺少可供保存的答题结果。')
			}

			// 将本轮训练结果写入当前用户的长期训练记忆
			const saved = await this.memories.recordTrainingResult(principal, {
				// 当前题目所属知识点
				topic: state.currentQuestion.topic,

				// 题目标题，用于后续展示或召回
				title: state.currentQuestion.title,

				// 本次回答的最终评估结果
				verdict: state.lastEvaluation.verdict,

				// 保存用户原始回答，作为后续训练记录的一部分
				answerSummary: state.answer,

				// 关联当前题目，便于追踪具体训练来源
				questionId: state.currentQuestion.id,

				// 保存反馈阶段实际引用的证据来源
				sourceIds: state.lastFeedback.sourceIds,

				// 判断当前题目的 topic 是否已经被记录为薄弱知识点
				struggled: state.struggledTopics.includes(state.currentQuestion.topic)
			})

			return {
				// 记录本次记忆保存结果，方便观察 Graph 执行链路
				trace: [
					...state.trace,
					saved
						? // 保存成功时，记录具体 Memory Key 和更新后的状态
							`save_memory：${saved.key} 更新为 ${saved.status}`
						: // 如果用户关闭了自动记忆，则只记录跳过原因
							`save_memory：${state.currentQuestion.topic} 已被用户禁止自动保存`
				]
			}
		}

		return new StateGraph(InterviewState)
			.addNode('dispatch', dispatch)
			.addNode('prepare_question', prepareQuestion)
			.addNode('evaluate_answer', evaluateAnswer)
			.addNode('retrieve_evidence', retrieveEvidence)
			.addNode('assess_evidence', assessEvidence)
			.addNode('compose_feedback', composeFeedback)
			.addNode('save_memory', saveTrainingMemory)
			.addEdge(START, 'dispatch')
			.addConditionalEdges('dispatch', routeEvent, [
				'prepare_question',
				'evaluate_answer'
			])
			.addConditionalEdges('evaluate_answer', routeAfterEvaluation, [
				'retrieve_evidence',
				'compose_feedback'
			])
			.addEdge('retrieve_evidence', 'assess_evidence')
			.addConditionalEdges('assess_evidence', routeAfterAssessment, [
				'retrieve_evidence',
				'compose_feedback'
			])
			.addEdge('compose_feedback', 'save_memory')
			.addEdge('prepare_question', END)
			.addEdge('save_memory', END)
			.compile({ checkpointer: this.storage.checkpointer })
	}

	/**
	 * 执行当前用户对应的 Agent Graph。
	 *
	 * sessionId 会作为 LangGraph 的 thread_id，
	 * 用于标识并恢复这一轮面试会话对应的 Graph 状态。
	 */
	async invoke(
		principal: Principal,
		sessionId: string,
		input: Partial<GraphState>
	) {
		// 根据当前用户身份创建 Graph，
		// 避免不同用户之间共享不应该共享的运行上下文。
		return this.createGraph(principal).invoke(input, {
			configurable: {
				// 将业务层的 Session ID 映射为 LangGraph 的 thread_id。
				// 后续同一个 sessionId 再次 invoke 时，可以继续对应的会话状态。
				thread_id: sessionId
			}
		}) as Promise<GraphState>
	}

	/**
	 * 获取指定面试 Session 当前保存的 Graph State。
	 *
	 * sessionId 与 LangGraph 的 thread_id 一一对应，
	 * 因此可以通过它找到该会话最近一次持久化的状态快照。
	 */
	async getState(principal: Principal, sessionId: string) {
		// 根据当前用户身份创建 Graph，
		// 并通过业务层的 sessionId 定位对应的 LangGraph Thread。
		const snapshot = await this.createGraph(principal).getState({
			configurable: {
				thread_id: sessionId
			}
		})

		// getState() 返回的是完整的 StateSnapshot，
		// values 才是当前 Thread 实际保存的业务状态。
		return snapshot.values as GraphState
	}

	toView(state: GraphState): InterviewStateView {
		return {
			sessionId: state.sessionId,
			mode: state.mode as SessionMode,
			kind: state.kind as SessionKind,
			status: state.status,
			profile: state.profile,
			messages: state.messages,
			currentQuestion: state.currentQuestion,
			lastEvaluation: state.lastEvaluation,
			lastFeedback: state.lastFeedback,
			evidence: state.evidence,
			usedMemoryKeys: state.usedMemoryKeys,
			turnNumber: state.turnNumber,
			trace: state.trace
		}
	}
}

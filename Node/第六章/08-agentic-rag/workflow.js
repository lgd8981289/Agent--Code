import { END, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { tool } from 'langchain'
import * as z from 'zod'
import {
	assessEvidence,
	buildSearchQuery,
	searchKnowledge
} from './knowledge.js'

const EvidenceTypeSchema = z.enum([
	'review_rule',
	'material_requirement',
	'arrival_rule',
	'maintenance_policy'
])

const ChunkSchema = z.object({
	id: z.string(),
	tenantId: z.string(),
	evidenceType: EvidenceTypeSchema,
	title: z.string(),
	content: z.string(),
	status: z.string(),
	version: z.number(),
	effectiveAt: z.string(),
	expiresAt: z.string().nullable()
})

const AgenticRagState = new StateSchema({
	question: z.string(),
	route: z.enum(['direct', 'retrieve', 'clarify']).nullable().default(null),
	requiredEvidence: z.array(EvidenceTypeSchema).default(() => []),
	clarificationQuestion: z.string().nullable().default(null),
	searchAttempts: z.number().int().nonnegative().default(0),
	searchedEvidenceTypes: z.array(EvidenceTypeSchema).default(() => []),
	candidates: z.array(ChunkSchema).default(() => []),
	usableEvidence: z.array(ChunkSchema).default(() => []),
	rejectedEvidence: z
		.array(z.object({ id: z.string(), reason: z.string() }))
		.default(() => []),
	missingEvidence: z.array(EvidenceTypeSchema).default(() => []),
	outcome: z
		.enum(['direct', 'answered', 'clarify', 'refused'])
		.nullable()
		.default(null),
	finalAnswer: z.string().default(''),
	sourceIds: z.array(z.string()).default(() => []),
	trace: z.array(z.string()).default(() => [])
})

function appendUnique(items, additions, getKey = (item) => item) {
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

/**
 * 创建 Agentic RAG Graph。
 *
 * Graph 负责根据用户问题自主决定：
 * 1. 是否需要查询企业知识库；
 * 2. 需要哪些类型的业务证据；
 * 3. 当前证据是否足够；
 * 4. 是否继续补查、直接回答、追问用户或拒绝回答。
 *
 * principal 属于可信身份上下文，由应用层传入，
 * 不能从用户问题或模型输出中提取，避免出现越权访问。
 */
export function createAgenticRagGraph({
	services,
	principal,
	now,
	maxSearches = 3
}) {
	// Graph 依赖三类模型能力：
	// decide：判断问题应该走哪条处理路径
	// direct：回答不需要企业知识库的问题
	// answer：基于已经核验的证据生成最终业务回答
	if (!services?.decide || !services?.direct || !services?.answer) {
		throw new Error('缺少模型服务。')
	}

	// tenantId 和 userId 必须由可信应用上下文提供，
	// 后续知识库检索和证据校验都会依赖这两个身份字段进行权限隔离。
	if (!principal?.tenantId || !principal?.userId) {
		throw new Error('缺少可信用户身份。')
	}

	/**
	 * 企业知识库检索 Tool。
	 *
	 * 模型只负责提供：
	 * - query：本次具体检索内容
	 * - evidenceType：当前需要补充的证据类型
	 *
	 * principal 不暴露给模型，而是通过闭包直接传入 searchKnowledge，
	 * 从而保证模型无法通过 Tool 参数伪造 tenantId 或 userId。
	 */
	const searchKnowledgeTool = tool(
		async ({ query, evidenceType }) =>
			searchKnowledge({
				principal,
				query,
				evidenceType
			}),
		{
			name: 'search_knowledge',
			description:
				'根据缺少的证据类型查询当前租户的企业知识库，一次只查询一类资料。',
			schema: z.object({
				query: z.string().min(1),
				evidenceType: EvidenceTypeSchema
			})
		}
	)

	/**
	 * Node：分析用户请求，决定后续处理路径。
	 *
	 * 模型需要判断：
	 * - direct：不需要企业知识，可以直接回答
	 * - clarify：缺少只能由用户提供的信息，需要追问
	 * - retrieve：需要查询企业知识库
	 *
	 * 对于 retrieve，还需要明确回答这个问题必须具备哪些证据类型。
	 */
	async function decideRequest(state) {
		const decision = await services.decide(state.question)

		console.log('`services.decide(state.question)` 返回的决策对象：', decision)

		// 去除模型可能返回的重复证据类型，
		// 后续会按照这些类型逐项判断证据是否齐全。
		const requiredEvidence = [...new Set(decision.requiredEvidence)]

		// 如果模型要求检索，却没有声明需要什么证据，
		// Graph 就无法确定后续应该检索什么，因此直接视为非法决策。
		if (decision.route === 'retrieve' && requiredEvidence.length === 0) {
			throw new Error('模型决定检索，但没有说明需要哪类证据。')
		}

		return {
			route: decision.route,

			// 回答当前问题所必须具备的全部证据类型。
			requiredEvidence,

			// 刚完成请求分析时，还没有进行检索，
			// 因此所有 requiredEvidence 默认都处于缺失状态。
			missingEvidence: requiredEvidence,

			// 当 route === clarify 时，用于向用户提出补充问题。
			clarificationQuestion: decision.clarificationQuestion,

			// trace 用于记录 Graph 的关键执行路径，方便调试和观察。
			trace: [
				...state.trace,
				`decide_request：${decision.route}；${decision.reason}`
			]
		}
	}

	/**
	 * Conditional Edge：
	 * 根据请求分析结果选择下一节点。
	 */
	function routeAfterDecision(state) {
		// 普通知识问题，不需要进入 RAG 流程。
		if (state.route === 'direct') return 'direct_answer'

		// 缺少只能由用户提供的信息，暂停检索并向用户追问。
		if (state.route === 'clarify') return 'clarify_user'

		// 其余情况进入企业知识库检索流程。
		return 'search_knowledge'
	}

	/**
	 * Node：针对当前缺失的一类证据执行一次知识库检索。
	 *
	 * 每轮只检索 missingEvidence 中的第一种证据，
	 * 检索完成后再统一进入 assess_evidence，
	 * 判断当前累计证据是否已经足够。
	 */
	async function retrieveMissingEvidence(state) {
		const evidenceType = state.missingEvidence[0]

		if (!evidenceType) {
			throw new Error('没有找到本轮需要补查的证据类型。')
		}

		// 根据原始问题和当前缺少的证据类型，
		// 构造更加聚焦的检索 Query。
		const query = buildSearchQuery(state.question, evidenceType)

		// 通过 Tool 查询当前租户允许访问的企业知识。
		const result = await searchKnowledgeTool.invoke({
			query,
			evidenceType
		})
		console.log('检索出的数据：', result)

		return {
			// 记录已经执行的检索次数，
			// routeAfterAssessment 会使用它控制最大搜索预算。
			searchAttempts: state.searchAttempts + 1,

			// 记录已经搜索过哪些证据类型，
			// 防止某一种缺失证据被反复查询形成死循环。
			searchedEvidenceTypes: appendUnique(state.searchedEvidenceTypes, [
				evidenceType
			]),

			// 将本轮检索结果合并到历史候选中，
			// 通过 chunk.id 去重，形成累计候选证据集合。
			candidates: appendUnique(
				state.candidates,
				result.candidates,
				(chunk) => chunk.id
			),

			trace: [
				...state.trace,
				`search_knowledge：${evidenceType}；返回 ${result.candidates.length} 条候选`
			]
		}
	}

	/**
	 * Node：对当前累计候选进行证据审核。
	 *
	 * 这里不直接相信向量检索返回的候选，
	 * 而是进一步检查候选是否：
	 * - 属于当前用户/租户允许访问的数据
	 * - 尚未过期
	 * - 能够满足 requiredEvidence 中要求的证据类型
	 *
	 * 最终将候选拆分为：
	 * usable：可以用于回答的证据
	 * rejected：被拒绝的候选
	 * missing：当前仍然缺失的证据类型
	 */
	function gradeEvidence(state) {
		const result = assessEvidence({
			candidates: state.candidates,
			principal,
			requiredEvidence: state.requiredEvidence,
			now
		})
		console.log('assessEvidence 返回的审核结果：', result)
		return {
			// 后续生成答案时，只允许使用已经通过审核的证据。
			usableEvidence: result.usable,

			// 保留被拒绝的资料，方便调试和解释证据为什么没有被使用。
			rejectedEvidence: result.rejected,

			// 更新仍然缺少的证据类型。
			// 该字段决定下一步是回答、继续检索还是拒答。
			missingEvidence: result.missing,

			trace: [
				...state.trace,
				result.missing.length === 0
					? 'assess_evidence：证据已经齐全'
					: `assess_evidence：仍缺少 ${result.missing.join('、')}`
			]
		}
	}

	/**
	 * Conditional Edge：
	 * 根据证据审核结果决定下一步。
	 *
	 * 路由优先级：
	 * 1. 证据齐全 → 生成答案
	 * 2. 达到最大搜索次数 → 拒答
	 * 3. 下一类缺失证据已经搜索过 → 拒答，避免重复搜索
	 * 4. 否则 → 继续补查下一类证据
	 */
	function routeAfterAssessment(state) {
		// 所需证据全部具备，可以进入最终答案生成。
		if (state.missingEvidence.length === 0) {
			return 'generate_answer'
		}

		// 已耗尽本次 Agent Run 的检索预算，
		// 即使仍有证据缺失，也不再无限循环搜索。
		if (state.searchAttempts >= maxSearches) {
			return 'refuse_answer'
		}

		const nextType = state.missingEvidence[0]

		// 如果当前仍然缺失的证据之前已经搜索过，
		// 说明继续用相同策略搜索大概率不会产生新信息。
		// 这里直接终止，而不是形成：
		// search → assess → search → assess 的无效循环。
		if (state.searchedEvidenceTypes.includes(nextType)) {
			return 'refuse_answer'
		}

		// 还有未尝试过的缺失证据类型，继续执行下一轮检索。
		return 'search_knowledge'
	}

	/**
	 * Node：基于已经审核通过的证据生成最终答案。
	 *
	 * 注意：
	 * 模型生成答案以后不能直接返回，
	 * 还需要对模型声明的 sourceIds 再做一次来源校验，
	 * 防止模型引用不存在或未授权的 Chunk。
	 */
	async function generateAnswer(state) {
		const response = await services.answer({
			question: state.question,

			// 只把审核通过的证据提供给生成模型，
			// rejectedEvidence 和原始 candidates 都不会进入回答上下文。
			evidence: state.usableEvidence
		})

		console.log('services.answer 返回的回答对象：', response)

		// 当前回答允许引用的来源，只能来自 usableEvidence。
		const allowedIds = new Set(state.usableEvidence.map((chunk) => chunk.id))

		// 检查模型返回的 sourceIds 中，
		// 是否存在没有出现在 usableEvidence 里的非法引用。
		const invalidIds = response.sourceIds.filter((id) => !allowedIds.has(id))

		// 找出模型真正引用到的证据分别覆盖了哪些 evidenceType。
		const citedTypes = new Set(
			state.usableEvidence
				.filter((chunk) => response.sourceIds.includes(chunk.id))
				.map((chunk) => chunk.evidenceType)
		)

		// 即使证据池本身已经齐全，也要求最终回答实际引用到
		// 每一种 requiredEvidence，避免模型遗漏关键依据。
		const missingCitation = state.requiredEvidence.some(
			(type) => !citedTypes.has(type)
		)

		// 只要存在非法来源，或者必要证据没有真正被引用，
		// 就拒绝返回该业务结论。
		if (invalidIds.length > 0 || missingCitation) {
			return {
				outcome: 'refused',
				finalAnswer: '答案没有通过来源校验，本次不返回未经支持的业务结论。',
				sourceIds: [],
				trace: [...state.trace, 'generate_answer：来源校验失败']
			}
		}

		// 答案和引用均通过校验后，才允许正式返回给用户。
		return {
			outcome: 'answered',
			finalAnswer: response.answer,
			sourceIds: response.sourceIds,
			trace: [...state.trace, 'generate_answer：答案和来源校验通过']
		}
	}

	/**
	 * Node：直接回答。
	 *
	 * 用于不依赖企业内部知识的问题，
	 * 整个过程不会访问知识库，也不会产生 sourceIds。
	 */
	async function directAnswer(state) {
		return {
			outcome: 'direct',
			finalAnswer: await services.direct(state.question),
			sourceIds: [],
			trace: [...state.trace, 'direct_answer：未查询知识库']
		}
	}

	/**
	 * Node：向用户追问。
	 *
	 * 当完成判断所需的信息只能由用户提供时，
	 * 不应该继续盲目检索知识库，而是明确要求用户补充条件。
	 */
	function clarifyUser(state) {
		return {
			outcome: 'clarify',
			finalAnswer: state.clarificationQuestion || '请补充完成判断所需的信息。',
			sourceIds: [],
			trace: [...state.trace, 'clarify_user：缺少用户才能提供的条件']
		}
	}

	/**
	 * Node：拒绝回答。
	 *
	 * 当经过允许次数的补查后，
	 * 仍然无法获得完成回答所必需的证据时，
	 * 明确返回证据不足，而不是让模型猜测业务结论。
	 */
	function refuseAnswer(state) {
		return {
			outcome: 'refused',
			finalAnswer:
				`根据当前知识库资料，无法回答这个问题。` +
				`缺少证据：${state.missingEvidence.join('、')}。`,
			sourceIds: [],
			trace: [...state.trace, 'refuse_answer：补查后仍然缺少可用证据']
		}
	}

	/**
	 * 构建 Agentic RAG 状态图。
	 *
	 * 主流程：
	 *
	 * START
	 *   ↓
	 * decide_request
	 *   ├─ direct  → direct_answer ─────────────→ END
	 *   ├─ clarify → clarify_user ──────────────→ END
	 *   └─ retrieve
	 *        ↓
	 * search_knowledge
	 *        ↓
	 * assess_evidence
	 *   ├─ 证据齐全 ─────→ generate_answer ────→ END
	 *   ├─ 仍可继续搜索 ─→ search_knowledge
	 *   └─ 无法继续补查 ─→ refuse_answer ──────→ END
	 *
	 * 因此这里的 Agentic 主要体现在：
	 * Graph 会根据当前 State 动态判断是否需要继续检索，
	 * 而不是预先固定执行一次“检索 → 生成”。
	 */
	return (
		new StateGraph(AgenticRagState)
			// 注册 Graph 中的各个执行节点
			.addNode('decide_request', decideRequest)
			.addNode('search_knowledge', retrieveMissingEvidence)
			.addNode('assess_evidence', gradeEvidence)
			.addNode('generate_answer', generateAnswer)
			.addNode('direct_answer', directAnswer)
			.addNode('clarify_user', clarifyUser)
			.addNode('refuse_answer', refuseAnswer)

			// Graph 从请求分析节点开始执行
			.addEdge(START, 'decide_request')

			// 根据模型的请求分类结果，
			// 动态进入直接回答、追问用户或知识库检索分支。
			.addConditionalEdges('decide_request', routeAfterDecision, [
				'direct_answer',
				'clarify_user',
				'search_knowledge'
			])

			// 每次知识库检索完成后，都必须重新审核当前累计证据。
			.addEdge('search_knowledge', 'assess_evidence')

			// 根据证据完整度和搜索预算，
			// 动态决定生成答案、继续补查或拒绝回答。
			.addConditionalEdges('assess_evidence', routeAfterAssessment, [
				'generate_answer',
				'search_knowledge',
				'refuse_answer'
			])

			// 四种最终结果节点执行完成后结束本次 Graph Run。
			.addEdge('generate_answer', END)
			.addEdge('direct_answer', END)
			.addEdge('clarify_user', END)
			.addEdge('refuse_answer', END)

			// 将 StateGraph 编译成可以 invoke 的可执行 Graph。
			.compile()
	)
}

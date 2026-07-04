const apiKey = process.env.ZHIPU_API_KEY
const evaluatorModel =
	process.env.EVALUATOR_MODEL ?? process.env.CHAT_MODEL ?? 'glm-4.7-flash'

/**
 * 计算单个问题的 Recall@K。
 *
 * Recall@K = TopK 中命中的相关 Chunk 数量 / 全部相关 Chunk 数量
 *
 * 如果一个问题没有任何相关 Chunk，这个指标没有分母，返回 null。
 * 这种问题应该单独评估拒答，而不是强行记成 0 或 1。
 */
export function recallAtK(retrievedChunks, relevantChunkIds, k) {
	// k 必须是正整数，比如 3、5、10。
	// 如果 k 不合法，后面的 TopK 计算就没有意义。
	if (!Number.isInteger(k) || k <= 0) {
		throw new Error('k 必须是大于 0 的整数。')
	}

	// relevantChunkIds 表示“这个问题真正应该命中的相关资料”。
	// 如果没有标注相关资料，就无法计算 Recall@K。
	// 这里返回 null，表示该样本不参与 Recall@K 统计。
	if (!Array.isArray(relevantChunkIds) || relevantChunkIds.length === 0) {
		return null
	}

	// 取出系统检索结果中的前 K 条。
	// 然后只保留每个 Chunk 的 id。
	//
	// 使用 Set 是为了方便后面判断：
	// 某个相关 Chunk id 是否出现在 TopK 结果中。
	const topKIds = new Set(retrievedChunks.slice(0, k).map((chunk) => chunk.id))

	// 对人工标注的相关 Chunk ID 去重。
	// 避免 relevantChunkIds 中重复出现同一个 id，导致分母被重复计算。
	const uniqueRelevantIds = [...new Set(relevantChunkIds)]

	// 统计 TopK 结果中命中了多少个相关 Chunk。
	//
	// 举例：
	// TopK = ['chunk-a', 'chunk-b', 'chunk-x']
	// Relevant = ['chunk-a', 'chunk-c']
	// 那么只命中了 chunk-a，hitCount = 1。
	const hitCount = uniqueRelevantIds.filter((id) => topKIds.has(id)).length

	// 按公式计算 Recall@K：
	// 命中的相关 Chunk 数量 / 全部相关 Chunk 数量
	return hitCount / uniqueRelevantIds.length
}

/**
 * 计算单个问题的 Reciprocal Rank，也就是 RR。
 *
 * RR 用来评估：第一份相关 Chunk 在检索结果中排得有多靠前。
 *
 * 计算方式： RR = 1 / 第一份相关 Chunk 的排名
 *
 * 举例：
 * - 第一份相关 Chunk 排在第 1 位：RR = 1 / 1 = 1
 * - 第一份相关 Chunk 排在第 2 位：RR = 1 / 2 = 0.5
 * - 第一份相关 Chunk 排在第 3 位：RR = 1 / 3 ≈ 0.333
 * - TopK 内没有任何相关 Chunk：RR = 0
 */
export function reciprocalRank(retrievedChunks, relevantChunkIds, k) {
	// k 必须是正整数，比如 3、5、10。
	// 如果 k 不合法，就无法明确“只看前 K 条”的范围。
	if (!Number.isInteger(k) || k <= 0) {
		throw new Error('k 必须是大于 0 的整数。')
	}

	// 如果这个问题没有人工标注的相关 Chunk，
	// 那么就无法计算 RR。
	//
	// 这里返回 null，表示该样本不参与后续 MRR 统计。
	if (!Array.isArray(relevantChunkIds) || relevantChunkIds.length === 0) {
		return null
	}

	// 把人工标注的相关 Chunk ID 转成 Set。
	//
	// 使用 Set 的好处是：
	// 后面判断某个 chunk.id 是否属于相关 Chunk 时，查询效率更高，写法也更清晰。
	const relevantIdSet = new Set(relevantChunkIds)

	// 只取检索结果的前 K 条进行评估。
	//
	// 然后从前往后查找：
	// 第一条出现在 relevantIdSet 中的 Chunk，也就是“第一份相关资料”。
	//
	// findIndex 返回的是数组下标：
	// - 如果第一份相关资料在第 1 位，下标是 0
	// - 如果第一份相关资料在第 2 位，下标是 1
	// - 如果没有找到，返回 -1
	const firstRelevantIndex = retrievedChunks
		.slice(0, k)
		.findIndex((chunk) => relevantIdSet.has(chunk.id))

	// 如果 TopK 里面没有任何相关 Chunk，则 RR = 0。
	if (firstRelevantIndex === -1) {
		return 0
	}

	// firstRelevantIndex 是从 0 开始的数组下标，
	// 但排名是从 1 开始的。
	//
	// 所以需要 + 1。
	//
	// 举例：
	// firstRelevantIndex = 0，说明排第 1，RR = 1 / 1
	// firstRelevantIndex = 1，说明排第 2，RR = 1 / 2
	return 1 / (firstRelevantIndex + 1)
}

/**
 * 计算一组数字的平均值。
 *
 * 平均值的计算方式：mean = 所有数字之和 / 数字个数
 *
 * 举例：
 * values = [1, 2, 3]
 * mean = (1 + 2 + 3) / 3 = 2
 */
export function mean(values) {
	// values 必须是一个数组，并且数组中至少要有一个元素。
	if (!Array.isArray(values) || values.length === 0) {
		throw new Error('计算平均值时至少需要一个数字。')
	}

	// reduce 用来累加数组中的每一个数字。
	//
	// total：当前已经累加出来的总和
	// value：当前正在遍历的数字
	// 0：初始总和，从 0 开始累加
	const total = values.reduce((total, value) => total + value, 0)

	// 平均值 = 总和 / 数字个数
	return total / values.length
}

/**
 * 构造 Faithfulness 评估所需的 messages。
 *
 * 评估模型负责两件事：
 * 1. 把答案拆成能够独立判断的 Claim
 * 2. 判断每个 Claim 是否能被检索上下文直接支持
 *
 * 最终分数不交给模型计算，避免模型随意给出一个总分。
 */
export function buildFaithfulnessMessages(evaluationCase) {
	const contexts = evaluationCase.retrievedChunks.map(
		({ id, title, content }) => ({ id, title, content })
	)

	return [
		{
			role: 'system',
			content: `你是 RAG 系统的 Faithfulness 评估器。

请把“待评估答案”拆成能够独立判断真假的 Claim，再判断每个 Claim 是否能从“检索上下文”中直接推出。

严格遵守以下规则：
1. 只能使用检索上下文，不得使用外部知识。
2. supported 只有在上下文能够直接支持 Claim 时才为 true。
3. supportingChunkIds 只能填写直接支持该 Claim 的 Chunk ID。
4. supported 为 false 时，supportingChunkIds 必须是空数组。
5. 不要评价答案是否流畅，也不要回答用户问题。
6. 只返回 JSON：
{"claims":[{"claim":"答案中的一个独立主张","supported":true,"supportingChunkIds":["Chunk ID"]}]}`
		},
		{
			role: 'user',
			content: `用户问题：${evaluationCase.question}

检索上下文：
${JSON.stringify(contexts, null, 2)}

待评估答案：
${evaluationCase.answer}`
		}
	]
}

/**
 * 使用智谱 Chat Completions 接口执行 Faithfulness 判断。
 */
export async function requestFaithfulnessJudgement(requestBody, key) {
	const response = await fetch(
		'https://open.bigmodel.cn/api/paas/v4/chat/completions',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${key}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(requestBody)
		}
	)

	const result = await response.json()

	if (!response.ok) {
		throw new Error(
			`Faithfulness 评估失败：${response.status} ${JSON.stringify(result)}`
		)
	}

	return result
}

/**
 * 校验评估模型返回的 Claim 列表。
 */
export function validateClaimJudgements(result, retrievedChunks) {
	if (!result || typeof result !== 'object' || !Array.isArray(result.claims)) {
		throw new Error('评估模型没有返回有效的 claims。')
	}

	if (result.claims.length === 0) {
		throw new Error('当前答案没有可评估的 Claim。')
	}

	const availableChunkIds = new Set(retrievedChunks.map((chunk) => chunk.id))

	return result.claims.map((item, index) => {
		if (!item || typeof item !== 'object') {
			throw new Error(`第 ${index + 1} 个 Claim 不是对象。`)
		}

		if (typeof item.claim !== 'string' || !item.claim.trim()) {
			throw new Error(`第 ${index + 1} 个 Claim 缺少有效文本。`)
		}

		if (typeof item.supported !== 'boolean') {
			throw new Error(`第 ${index + 1} 个 Claim 缺少 supported。`)
		}

		if (!Array.isArray(item.supportingChunkIds)) {
			throw new Error(
				`第 ${index + 1} 个 Claim 的 supportingChunkIds 必须是数组。`
			)
		}

		const supportingChunkIds = [...new Set(item.supportingChunkIds)]

		for (const chunkId of supportingChunkIds) {
			if (typeof chunkId !== 'string' || !availableChunkIds.has(chunkId)) {
				throw new Error(`评估模型引用了不存在的 Chunk ID：${chunkId}`)
			}
		}

		if (item.supported && supportingChunkIds.length === 0) {
			throw new Error(`第 ${index + 1} 个 Claim 缺少支持它的 Chunk ID。`)
		}

		if (!item.supported && supportingChunkIds.length > 0) {
			throw new Error(`不受支持的 Claim 不应该绑定 Chunk ID。`)
		}

		return {
			claim: item.claim.trim(),
			supported: item.supported,
			supportingChunkIds
		}
	})
}

/**
 * 计算单个答案的 Faithfulness，也就是“忠实度”。
 *
 * Faithfulness 用来评估：
 * 大模型生成的答案，是否忠实于检索回来的上下文资料。
 *
 * 在这里，我们把答案拆成多个 Claim，也就是多个“答案断言”。
 *
 * 计算方式：Faithfulness = 有上下文支持的 Claim 数量 / 全部 Claim 数量
 *
 * 举例：
 * 全部 Claim 数量 = 4
 * 有上下文支持的 Claim 数量 = 3
 *
 * Faithfulness = 3 / 4 = 0.75
 */
export async function evaluateFaithfulness(
	evaluationCase,
	{
		key = apiKey,
		model = evaluatorModel,
		requester = requestFaithfulnessJudgement
	} = {}
) {
	// Faithfulness 评估需要调用大模型。
	// 如果没有配置 API Key，就无法发起评估请求。
	if (!key) {
		throw new Error('没有检测到 ZHIPU_API_KEY，无法执行 Faithfulness 评估。')
	}

	// 调用评估模型，让模型判断答案中的每个 Claim 是否能被检索上下文支持。
	//
	// 这里并不是让模型重新回答用户问题，
	// 而是让模型扮演“评测器”的角色。
	const response = await requester(
		{
			// 指定评估模型。
			model,

			// 构造 Faithfulness 评估用的 messages。
			//
			// 里面通常会包含：
			// 1. 用户问题
			// 2. 模型生成的答案
			// 3. 检索回来的 Chunk
			// 4. 评估要求：拆 Claim，并判断每个 Claim 是否被 Chunk 支持
			messages: buildFaithfulnessMessages(evaluationCase),

			// 要求模型返回 JSON，方便后续程序解析。
			response_format: { type: 'json_object' },

			// 关闭 thinking，避免评估结果中混入额外推理内容。
			thinking: { type: 'disabled' },

			// temperature 设置为 0，尽量让评估结果稳定。
			temperature: 0,

			// 这里不使用流式输出，因为评估结果需要一次性拿到完整 JSON。
			stream: false
		},
		key
	)

	// 从模型响应中取出文本内容。
	// 正常情况下，这里应该是一段 JSON 字符串。
	const content = response.choices?.[0]?.message?.content

	// 如果模型没有返回内容，说明这次评估失败。
	if (!content) {
		throw new Error('Faithfulness 评估没有返回可用内容。')
	}

	let parsed

	try {
		// 将模型返回的 JSON 字符串解析成 JavaScript 对象。
		parsed = JSON.parse(content)
	} catch {
		// 即使设置了 response_format，模型也不一定 100% 返回合法 JSON。
		// 所以这里必须做异常处理，避免程序直接崩溃。
		throw new Error(`Faithfulness 评估没有返回合法 JSON：${content}`)
	}

	// 校验模型返回的 Claim 判断结果。
	//
	// validateClaimJudgements 通常需要检查：
	// 1. 返回结果是不是数组
	// 2. 每个 Claim 是否包含必要字段
	// 3. supported 是否是布尔值
	// 4. 引用的 sourceChunkIds 是否真的存在于 retrievedChunks 中
	//
	// 这一步很关键：
	// 因为模型返回的是外部数据，不能直接相信。
	const claims = validateClaimJudgements(parsed, evaluationCase.retrievedChunks)

	// 如果没有拆出任何 Claim，就无法计算 Faithfulness。
	// 这里直接抛错，说明该评测样本或模型返回结果不符合预期。
	if (claims.length === 0) {
		throw new Error('Faithfulness 评估没有生成任何 Claim，无法计算分数。')
	}

	// 统计有多少个 Claim 能被上下文支持。
	//
	// supported = true 表示：
	// 这个 Claim 可以从 retrievedChunks 中找到依据。
	const supportedCount = claims.filter((claim) => claim.supported).length

	// 返回完整评估结果。
	return {
		// Faithfulness 分数：
		// 有上下文支持的 Claim 数量 / 全部 Claim 数量
		score: supportedCount / claims.length,

		// 被上下文支持的 Claim 数量。
		supportedCount,

		// 全部 Claim 数量。
		totalCount: claims.length,

		// 每个 Claim 的详细判断结果。
		//
		// 这里可以用于后续展示：
		// 哪些断言被支持，哪些断言没有依据。
		claims
	}
}

/**
 * 计算单个案例的确定性检索指标。
 */
export function evaluateRetrieval(evaluationCase, k) {
	return {
		recall: recallAtK(
			evaluationCase.retrievedChunks,
			evaluationCase.relevantChunkIds,
			k
		),
		reciprocalRank: reciprocalRank(
			evaluationCase.retrievedChunks,
			evaluationCase.relevantChunkIds,
			k
		)
	}
}

/**
 * 根据指标组合给出排查方向。
 *
 * 这只是定位线索，不是绝对因果关系。
 */
export function diagnose({ recall, reciprocalRank, faithfulness }) {
	if (recall !== null && recall < 1) {
		return '优先检查召回：分块、Embedding、Query Rewrite、BM25 或过滤条件'
	}

	if (reciprocalRank < 1) {
		return '优先检查排序：融合策略、RRF、Weighted 或 Rerank'
	}

	if (faithfulness === null) {
		return '召回和排序正常；需要完整模式继续检查答案 Faithfulness'
	}

	if (faithfulness < 1) {
		return '优先检查生成：Prompt、上下文噪声和答案约束'
	}

	return '当前案例的召回、排序和生成指标均正常'
}

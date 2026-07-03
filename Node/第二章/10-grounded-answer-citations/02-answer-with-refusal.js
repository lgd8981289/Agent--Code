// 从环境变量中读取智谱 API Key。
// API Key 不建议直接写在代码中，通常放在 .env 文件里。
const apiKey = process.env.ZHIPU_API_KEY

// 从环境变量中读取聊天模型。
// 如果没有配置 CHAT_MODEL，则默认使用 glm-4.7-flash。
const chatModel = process.env.CHAT_MODEL ?? 'glm-4.7-flash'

// 用户问题。
// 这里用户问的是“保修几年”。
const question = '这台咖啡机可以免费保修几年？'

// 当知识库资料不足以回答问题时，统一返回这个拒答内容。
// 这样可以避免模型自由发挥、编造答案。
const REFUSAL_ANSWER = '根据当前知识库资料，无法回答这个问题。'

// 向量检索可能仍会返回“最接近”的资料，
// 但“最接近”不代表“一定能回答问题”。
//
// 当前 Chunk 讲的是退款到账时间，
// 和用户问的“咖啡机免费保修几年”没有直接关系。
// 所以后面需要让模型判断：这些 Chunk 是否真的支持答案。
const chunks = [
	{
		id: 'chunk-refund-arrival',
		title: '退款到账时间',
		source: 'knowledge/refund-arrival.md',
		content:
			'退款审核通过后，款项会在 3 到 5 个工作日内原路退回。不同银行的到账时间可能存在差异。'
	}
]

/**
 * 检查 API Key 是否存在。
 *
 * 只有真正调用模型接口时，才需要 API Key。
 * 如果没有配置，直接抛出错误，避免发起无效请求。
 */
function assertApiKey() {
	if (!apiKey) {
		throw new Error('没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。')
	}
}

/**
 * 创建统一的拒答结果。
 *
 * 当知识库没有足够依据时，不返回来源，
 * 因为没有任何 Chunk 能直接支持这个答案。
 */
function createRefusal() {
	return {
		status: 'insufficient_evidence',
		answer: REFUSAL_ANSWER,
		sources: []
	}
}

/**
 * 构造发送给大模型的 messages。
 *
 * 这里的核心不是让模型直接回答，
 * 而是让模型先判断：
 * “给定的 Chunk 是否能够直接支持用户问题的答案？”
 *
 * 如果能支持，返回 answered。
 * 如果不能支持，必须返回 insufficient_evidence。
 */
function buildMessages() {
	return [
		{
			role: 'system',
			content: `你是企业知识库问答助手，只能根据用户提供的知识库 Chunk 回答问题。

请先判断 Chunk 是否能够直接支持问题的答案。

返回要求：
1. 能够直接支持答案时，status 返回 answered，answer 返回最终答案，sourceChunkIds 返回直接支持答案的 Chunk ID。
2. 无法直接支持答案时，不得使用自己的知识补充或猜测。status 返回 insufficient_evidence，answer 固定返回“${REFUSAL_ANSWER}”，sourceChunkIds 返回空数组。
3. 只返回下面结构的 JSON，不要返回其他内容：
{"status":"answered 或 insufficient_evidence","answer":"最终答案或拒答内容","sourceChunkIds":["Chunk ID"]}`
		},
		{
			role: 'user',

			// 把用户问题和候选 Chunk 一起交给模型。
			//
			// 这里没有把 source 字段传给模型，
			// 因为 source 是系统侧保存的来源元数据。
			//
			// 模型只需要判断 id、title、content 是否能支持答案，
			// 最后返回 sourceChunkIds 即可。
			content: `用户问题：${question}\n\n知识库 Chunk：\n${JSON.stringify(
				chunks.map(({ id, title, content }) => ({ id, title, content })),
				null,
				2
			)}`
		}
	]
}

/**
 * 调用大模型生成结果。
 *
 * 模型需要返回一个 JSON 字符串，结构大致是：
 *
 * {
 *   "status": "answered",
 *   "answer": "xxx",
 *   "sourceChunkIds": ["chunk-id"]
 * }
 *
 * 或者：
 *
 * {
 *   "status": "insufficient_evidence",
 *   "answer": "根据当前知识库资料，无法回答这个问题。",
 *   "sourceChunkIds": []
 * }
 */
async function callModel() {
	// 调用模型前，先检查 API Key。
	assertApiKey()

	// 调用智谱 Chat Completions 接口。
	const response = await fetch(
		'https://open.bigmodel.cn/api/paas/v4/chat/completions',
		{
			method: 'POST',
			headers: {
				// 使用 Bearer Token 进行接口鉴权。
				Authorization: `Bearer ${apiKey}`,

				// 请求体格式为 JSON。
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				// 使用的模型名称。
				model: chatModel,

				// 传入 system 规则、用户问题和候选 Chunk。
				messages: buildMessages(),

				// 要求模型返回 JSON 对象。
				// 但工程上仍然需要手动 JSON.parse 校验。
				response_format: { type: 'json_object' },

				// 关闭思考模式。
				// 当前任务主要是依据判断，不需要复杂推理链路。
				thinking: { type: 'disabled' },

				// temperature 设置为 0，让输出更加稳定。
				temperature: 0,

				// 非流式返回，方便一次性解析完整 JSON。
				stream: false
			})
		}
	)

	// 解析接口返回结果。
	const result = await response.json()

	// 如果状态码不是 2xx，说明模型调用失败。
	if (!response.ok) {
		throw new Error(
			`答案生成失败：${response.status} ${JSON.stringify(result)}`
		)
	}

	// 取出模型返回的文本内容。
	const content = result.choices?.[0]?.message?.content

	if (!content) {
		throw new Error('模型没有返回可用内容。')
	}

	// 模型返回的是字符串形式的 JSON，
	// 这里需要转换成真正的 JS 对象。
	try {
		return JSON.parse(content)
	} catch {
		throw new Error(`模型没有返回合法 JSON：${content}`)
	}
}

/**
 * 校验并规范化模型返回结果。
 *
 * 这一步非常重要：
 * 不能因为模型返回了 JSON，就直接相信它。
 *
 * 这里会检查：
 * 1. status 是否合法
 * 2. sourceChunkIds 是否是数组
 * 3. 拒答时是否没有来源
 * 4. 正常回答时是否有 answer 和 sourceChunkIds
 * 5. 模型引用的 Chunk ID 是否真实存在
 */
function validateResult(modelResult) {
	// 模型返回值必须是对象。
	if (!modelResult || typeof modelResult !== 'object') {
		throw new Error('模型没有返回 JSON 对象。')
	}

	// status 只能是 answered 或 insufficient_evidence。
	if (!['answered', 'insufficient_evidence'].includes(modelResult.status)) {
		throw new Error(`模型返回了无效 status：${modelResult.status}`)
	}

	// sourceChunkIds 必须是数组。
	if (!Array.isArray(modelResult.sourceChunkIds)) {
		throw new Error('模型返回的 sourceChunkIds 必须是数组。')
	}

	// 如果模型判断资料不足，需要进入拒答逻辑。
	if (modelResult.status === 'insufficient_evidence') {
		// 拒答时不能携带来源。
		// 因为既然资料不足，就说明没有 Chunk 能直接支持答案。
		if (modelResult.sourceChunkIds.length > 0) {
			throw new Error('拒答结果不应该包含信息来源。')
		}

		// 返回系统统一定义的拒答结果，
		// 而不是直接使用模型生成的内容。
		return createRefusal()
	}

	// 如果是正常回答，必须同时具备：
	// 1. 非空 answer
	// 2. 至少一个 sourceChunkId
	if (
		typeof modelResult.answer !== 'string' ||
		!modelResult.answer.trim() ||
		modelResult.sourceChunkIds.length === 0
	) {
		throw new Error('正常回答必须包含 answer 和 sourceChunkIds。')
	}

	// 把 chunks 转成 Map，方便根据 Chunk ID 快速查找原始 Chunk。
	const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]))

	// 根据模型返回的 sourceChunkIds 找到对应来源。
	// 使用 Set 去重，避免重复展示同一个来源。
	const sources = [...new Set(modelResult.sourceChunkIds)].map((chunkId) => {
		const chunk = chunkMap.get(chunkId)

		// 如果模型返回了不存在的 Chunk ID，直接报错。
		// 这一步可以防止模型编造引用来源。
		if (!chunk) {
			throw new Error(`模型引用了不存在的 Chunk ID：${chunkId}`)
		}

		return chunk
	})

	// 返回最终规范化后的结果。
	return {
		status: 'answered',
		answer: modelResult.answer.trim(),
		sources
	}
}

/**
 * 生成最终答案。
 *
 * 这里额外处理了一种情况：
 * 如果检索阶段一条 Chunk 都没有返回，
 * 说明没有任何知识库依据，可以直接拒答，不需要再调用模型。
 */
async function generateAnswer() {
	// 一条 Chunk 都没有时，程序可以直接拒答，不需要再调用模型。
	if (chunks.length === 0) {
		return createRefusal()
	}

	// 有候选 Chunk 时，调用模型判断这些 Chunk 是否足以回答问题。
	const modelResult = await callModel()

	// 对模型返回结果做严格校验，并绑定真实来源。
	return validateResult(modelResult)
}

/**
 * 打印最终回答结果。
 *
 * 当前案例中，用户问的是“咖啡机免费保修几年”，
 * 但知识库 Chunk 只有“退款到账时间”，
 * 因此合理结果应该是拒答。
 */
function printAnswer(result) {
	console.log('================ RAG 拒答案例 ================')
	console.log(`用户问题：${question}`)
	console.log(`候选 Chunk 数量：${chunks.length}`)
	console.log(`回答状态：${result.status}`)
	console.log(`回答：${result.answer}`)
	console.log(
		`信息来源：${result.sources.length === 0 ? '无' : result.sources.length}`
	)
}

// 执行完整流程：
// 1. 判断是否有候选 Chunk
// 2. 调用模型判断 Chunk 是否能支持答案
// 3. 校验模型结果
// 4. 输出最终答案
const result = await generateAnswer()

// 打印回答。
printAnswer(result)

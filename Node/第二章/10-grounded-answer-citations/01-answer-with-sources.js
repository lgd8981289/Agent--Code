// 从环境变量中读取智谱 API Key。
// 注意：API Key 不应该直接写死在代码里，而是放到 .env 文件中。
const apiKey = process.env.ZHIPU_API_KEY

// 从环境变量中读取聊天模型名称。
// 如果没有配置 CHAT_MODEL，就默认使用 glm-4.7-flash。
const chatModel = process.env.CHAT_MODEL ?? 'glm-4.7-flash'

// 用户提出的问题。
// 在真实项目中，这个问题一般来自前端输入。
const question = '订单 A1024 的咖啡机退款 3500 元，系统能否直接通过审核？'

// 模拟第 09 节经过 Rerank 后留下的最终 Chunk。
//
// source 是文档入库时保存的 Metadata，不是模型生成的。
// 这样做的好处是：
// 模型只需要返回 Chunk ID，系统再根据 Chunk ID 找到真实来源，
// 避免模型自己编造来源。
const chunks = [
	{
		// Chunk 的唯一标识。
		// 后面模型返回引用来源时，需要返回这个 id。
		id: 'chunk-refund-threshold',

		// Chunk 的标题，方便模型理解这段内容是什么。
		title: '退款金额审核规则',

		// Chunk 来源文件。
		// 这是入库时保存的元数据，用于最终展示信息来源。
		source: 'knowledge/refund-policy.md',

		// Chunk 原文内容。
		// 模型回答问题时，只能基于这里的内容进行判断。
		content: '退款金额超过 2000 元时，订单必须转入人工审核，系统不得直接通过。'
	},
	{
		id: 'chunk-auto-review',
		title: '自动审核适用范围',
		source: 'knowledge/auto-review-policy.md',
		content: '自动审核仅适用于退款金额不超过 2000 元且未触发风控的订单。'
	}
]

/**
 * 检查 API Key 是否存在。
 *
 * 所有真正调用模型接口的函数，在请求前都应该先检查 API Key。
 * 如果没有配置 API Key，直接抛出错误，避免发起无效请求。
 */
function assertApiKey() {
	if (!apiKey) {
		throw new Error('没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。')
	}
}

/**
 * 构造发给大模型的 messages。
 *
 * RAG 的关键就在这里：
 * 把“用户问题 + 检索出来的知识库 Chunk”一起放进 Prompt，
 * 让模型基于这些 Chunk 生成答案。
 *
 * 这里分成两个角色：
 * 1. system：告诉模型它应该如何回答，以及必须返回什么格式。
 * 2. user：提供真实的用户问题和知识库 Chunk。
 */
function buildMessages() {
	return [
		{
			role: 'system',
			content: `你是企业知识库问答助手。

请只根据用户提供的知识库 Chunk 回答问题。

返回要求：
1. answer 是给用户的最终答案。
2. sourceChunkIds 只填写直接支持答案的 Chunk ID。
3. sourceChunkIds 至少包含一个 ID，不得编造不存在的 ID。
4. 只返回下面结构的 JSON，不要返回其他内容：
{"answer":"最终答案","sourceChunkIds":["Chunk ID"]}`
		},
		{
			role: 'user',

			// 这里把用户问题和知识库 Chunk 一起交给模型。
			//
			// 注意：
			// 这里没有把 source 字段传给模型。
			// 因为 source 是系统侧用于展示来源的元数据，
			// 模型只需要知道 Chunk 的 id、title、content 即可。
			//
			// 模型生成答案后，只返回 sourceChunkIds。
			// 系统再用 sourceChunkIds 去 chunks 里查找真实 source。
			content: `用户问题：${question}\n\n知识库 Chunk：\n${JSON.stringify(
				chunks.map(({ id, title, content }) => ({ id, title, content })),
				null,
				2
			)}`
		}
	]
}

/**
 * 调用大模型生成答案。
 *
 * 这个函数负责：
 * 1. 检查 API Key
 * 2. 请求智谱 Chat Completions 接口
 * 3. 要求模型返回 JSON
 * 4. 解析模型返回结果
 */
async function callModel() {
	// 调用模型前，先确认 API Key 已配置。
	assertApiKey()

	// 调用智谱大模型接口。
	const response = await fetch(
		'https://open.bigmodel.cn/api/paas/v4/chat/completions',
		{
			method: 'POST',
			headers: {
				// 使用 Bearer Token 进行鉴权。
				Authorization: `Bearer ${apiKey}`,

				// 请求体使用 JSON 格式。
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				// 使用的聊天模型。
				model: chatModel,

				// 发给模型的 messages。
				// 里面包含 system 约束、用户问题和知识库 Chunk。
				messages: buildMessages(),

				// 要求模型尽量返回 JSON 对象。
				// 注意：即使设置了这个参数，工程上仍然不能完全相信模型一定返回合法 JSON，
				// 所以下面还会手动 JSON.parse 校验。
				response_format: { type: 'json_object' },

				// 关闭思考模式。
				// 当前任务只是基于明确规则回答，不需要复杂推理。
				thinking: { type: 'disabled' },

				// temperature 设置为 0，让输出更稳定、更确定。
				temperature: 0,

				// 非流式返回。
				// 这里为了演示简单，直接等模型一次性返回完整结果。
				stream: false
			})
		}
	)

	// 解析接口返回的 JSON。
	const result = await response.json()

	// 如果接口状态码不是 2xx，说明调用失败。
	// 这里把状态码和返回内容都抛出来，方便排查问题。
	if (!response.ok) {
		throw new Error(
			`答案生成失败：${response.status} ${JSON.stringify(result)}`
		)
	}

	// 从模型返回结果中取出 assistant message 的 content。
	const content = result.choices?.[0]?.message?.content

	// 如果 content 不存在，说明模型没有返回可用内容。
	if (!content) {
		throw new Error('模型没有返回可用内容。')
	}

	// 模型返回的是字符串形式的 JSON。
	// 这里需要手动 JSON.parse，转换成真正的 JS 对象。
	try {
		return JSON.parse(content)
	} catch {
		// 如果解析失败，说明模型没有严格按照 JSON 格式返回。
		throw new Error(`模型没有返回合法 JSON：${content}`)
	}
}

/**
 * 根据模型返回的 sourceChunkIds，绑定真实来源信息。
 *
 * 模型只负责返回：
 * {
 *   answer: '...',
 *   sourceChunkIds: ['chunk-refund-threshold']
 * }
 *
 * 但最终展示给用户时，需要展示：
 * - 答案
 * - 来源标题
 * - 来源文件
 * - Chunk ID
 * - Chunk 原文
 *
 * 所以这里要把 sourceChunkIds 还原成完整 Chunk。
 */
function attachSources(modelResult) {
	// 校验模型返回的结果必须是对象。
	if (!modelResult || typeof modelResult !== 'object') {
		throw new Error('模型没有返回 JSON 对象。')
	}

	// 校验 answer 必须是非空字符串。
	if (typeof modelResult.answer !== 'string' || !modelResult.answer.trim()) {
		throw new Error('模型没有返回有效 answer。')
	}

	// 校验 sourceChunkIds 必须是非空数组。
	// 这样可以保证每个答案至少有一个来源依据。
	if (
		!Array.isArray(modelResult.sourceChunkIds) ||
		modelResult.sourceChunkIds.length === 0
	) {
		throw new Error('模型没有返回有效 sourceChunkIds。')
	}

	// 把 chunks 转成 Map，方便通过 chunk.id 快速查找 Chunk。
	//
	// 结构大概是：
	// {
	//   'chunk-refund-threshold' => {...},
	//   'chunk-auto-review' => {...}
	// }
	const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]))

	// 根据模型返回的 sourceChunkIds 找到对应的 Chunk。
	//
	// 使用 Set 去重，避免模型重复返回同一个 Chunk ID。
	const sources = [...new Set(modelResult.sourceChunkIds)].map((chunkId) => {
		const chunk = chunkMap.get(chunkId)

		// 如果模型返回了一个不存在的 Chunk ID，必须直接报错。
		// 这一步很关键：
		// 可以防止模型编造来源。
		if (!chunk) {
			throw new Error(`模型引用了不存在的 Chunk ID：${chunkId}`)
		}

		return chunk
	})

	// 返回最终的答案和完整来源信息。
	return {
		// 去掉 answer 前后的空白字符。
		answer: modelResult.answer.trim(),

		// sources 是系统根据 Chunk ID 查出来的真实来源，
		// 不是模型自己生成的来源。
		sources
	}
}

/**
 * 打印最终结果。
 *
 * 这里展示的是“带来源的 RAG 回答”：
 * 1. 用户问题
 * 2. 模型答案
 * 3. 支持答案的来源 Chunk
 */
function printAnswer(result) {
	console.log('================ 带来源的 RAG 回答 ================')
	console.log(`用户问题：${question}`)
	console.log(`回答：${result.answer}`)
	console.log('信息来源：')

	result.sources.forEach((source, index) => {
		console.log(`\n[${index + 1}] ${source.title}`)
		console.log(`文件：${source.source}`)
		console.log(`Chunk ID：${source.id}`)
		console.log(`原文：${source.content}`)
	})
}

// 调用模型，得到模型返回的原始 JSON 结果。
// 预期结构：
// {
//   answer: 'xxx',
//   sourceChunkIds: ['chunk-refund-threshold', 'chunk-auto-review']
// }
const modelResult = await callModel()

// 根据模型返回的 sourceChunkIds，绑定真实 Chunk 来源。
// 这一步是 RAG 引用来源的关键：
// 模型不直接生成来源，而是返回 Chunk ID，系统再查真实来源。
const answerWithSources = attachSources(modelResult)

// 打印最终带来源的回答。
printAnswer(answerWithSources)

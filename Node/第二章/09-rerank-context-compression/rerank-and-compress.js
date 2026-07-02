import { candidates, question } from './candidate-documents.js'

// 从环境变量中读取 API Key 和模型配置
const apiKey = process.env.ZHIPU_API_KEY

// Rerank 模型：用于对候选资料重新排序
const rerankModel = process.env.RERANK_MODEL ?? 'rerank'

// Chat 模型：用于做 Context Compression，也就是上下文压缩
const chatModel = process.env.CHAT_MODEL ?? 'glm-4.7-flash'

/**
 * 检查 API Key 是否存在。
 * 所有需要调用智谱 API 的函数，在调用前都先执行这个检查。
 */
function assertApiKey() {
	if (!apiKey) {
		throw new Error('没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。')
	}
}

/**
 * 使用专用 Rerank 模型，对候选 Chunk 重新计算相关性并排序。
 *
 * query：用户问题
 * documents：前面检索阶段召回的候选 Chunk
 * topN：最终保留相关性最高的前 N 条
 */
async function rerankDocuments(query, documents, topN = 4) {
	assertApiKey()

	// 调用智谱 Rerank API
	const response = await fetch('https://open.bigmodel.cn/api/paas/v4/rerank', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: rerankModel,

			// 用户原始问题
			query,

			// Rerank 模型接收的是字符串数组，这里把标题和正文拼成完整候选文本
			documents: documents.map(
				(document) => `${document.title}\n${document.content}`
			),

			// 只返回排序后的前 topN 条
			top_n: topN,

			// 不让 API 返回原始文档内容，后面通过 index 从本地 documents 中取回
			return_documents: false,

			// 返回原始相关性分数，方便观察排序效果
			return_raw_scores: true
		})
	})

	const result = await response.json()

	// API 调用失败时，把状态码和接口返回信息一起抛出，方便排查问题
	if (!response.ok) {
		throw new Error(
			`Rerank API 调用失败：${response.status} ${JSON.stringify(result)}`
		)
	}

	// 防御式校验：确保接口返回了 results 数组
	if (!Array.isArray(result.results)) {
		throw new Error('Rerank API 没有返回可用的 results。')
	}

	// 根据 Rerank 返回的 index，把排序后的结果重新映射回原始 document
	return result.results.map((item) => {
		const document = documents[item.index]

		if (!document) {
			throw new Error(`Rerank API 返回了无效文档下标：${item.index}`)
		}

		return {
			...document,

			// 给每个 Chunk 附加 Rerank 模型计算出来的相关性分数
			rerankScore: item.relevance_score
		}
	})
}

/**
 * 把 Chunk 拆成句子，并给每句话分配稳定 ID。
 *
 * 后面的模型只负责选择句子 ID，
 * 不让模型直接改写、总结或重新生成压缩后的正文。
 *
 * 这样可以保证最终上下文仍然来自原文，减少模型压缩时引入幻觉。
 */
function createSentenceRecords(documents) {
	return documents.flatMap((document) => {
		// 使用简单正则按中文/英文标点切句
		const sentences =
			document.content
				.match(/[^。！？!?]+[。！？!?]?/gu)
				?.map((item) => item.trim()) ?? []

		// 给每个句子生成稳定 ID，并记录它来自哪个 Chunk
		return sentences.filter(Boolean).map((text, index) => ({
			sentenceId: `${document.id}-s${index + 1}`,
			chunkId: document.id,
			text
		}))
	})
}

/**
 * 构造 Context Compression 所需的 messages。
 *
 * system message 用来约束模型的行为：
 * 只选择句子 ID，不改写正文，不补充信息。
 */
function buildCompressionMessages(query, sentenceRecords) {
	return [
		{
			role: 'system',
			content: `你是 RAG 系统中的上下文过滤器。

请从候选句子中，选出能够直接回答用户问题，或者是得出答案所必需的原句。

要求：
1. 只返回句子 ID，不要改写、总结或补充原文。
2. 只选择包含业务规则、判断条件或处理结论，并且能支持当前问题答案的句子。
3. 仅仅重复订单号、商品、金额等用户信息，但不包含处理规则的句子，必须排除。
4. 发票、延保、到账时间、后台记录和处理进度等不能回答当前问题的内容，必须排除。
5. 保留原文中的关键业务条件、阈值和强制性表述。
6. 输出前逐条检查：删除这句话以后，是否仍然能够得出同样的审核结论？如果可以，就不要选择。
7. 只返回 JSON：{"selectedSentenceIds":["句子ID"]}`
		},
		{
			role: 'user',
			content: `用户问题：${query}\n\n候选句子：\n${JSON.stringify(sentenceRecords, null, 2)}`
		}
	]
}

/**
 * 使用大模型选择相关句子，再由程序从原文中取回内容。
 *
 * 这种方式属于抽取式 Context Compression：
 * - 模型只判断哪些句子有用；
 * - 程序负责根据句子 ID 取回原文；
 * - 最终上下文不由模型重新生成。
 */
async function compressContext(query, documents) {
	assertApiKey()

	// 先把 Chunk 拆成句子级别的候选项
	const sentenceRecords = createSentenceRecords(documents)

	// 调用 Chat Completions，让模型选择真正有用的句子 ID
	const response = await fetch(
		'https://open.bigmodel.cn/api/paas/v4/chat/completions',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: chatModel,
				messages: buildCompressionMessages(query, sentenceRecords),

				// 强制模型返回 JSON 对象，降低解析失败概率
				response_format: { type: 'json_object' },

				// 关闭 thinking，降低延迟和成本；这里任务是抽取，不需要复杂推理
				thinking: { type: 'disabled' },

				// temperature 设为 0，让选择结果尽量稳定
				temperature: 0,

				// 这里不需要流式输出，直接拿完整 JSON 即可
				stream: false
			})
		}
	)

	const result = await response.json()

	if (!response.ok) {
		throw new Error(
			`Context Compression 调用失败：${response.status} ${JSON.stringify(result)}`
		)
	}

	// 读取模型返回的 message.content
	const content = result.choices?.[0]?.message?.content

	if (!content) {
		throw new Error('Context Compression 没有返回可用内容。')
	}

	let selectedSentenceIds

	try {
		// 解析模型返回的 JSON 字符串
		const parsed = JSON.parse(content)
		selectedSentenceIds = parsed.selectedSentenceIds
	} catch {
		throw new Error(`Context Compression 没有返回合法 JSON：${content}`)
	}

	// 校验 selectedSentenceIds 是否为数组
	if (!Array.isArray(selectedSentenceIds)) {
		throw new Error('selectedSentenceIds 必须是数组。')
	}

	// 建立 sentenceId 到原始句子的映射，方便后续快速取回原文
	const sentenceMap = new Map(
		sentenceRecords.map((sentence) => [sentence.sentenceId, sentence])
	)

	// 去重后，根据模型返回的句子 ID 找回对应句子
	const selectedSentences = [...new Set(selectedSentenceIds)].map(
		(sentenceId) => {
			const sentence = sentenceMap.get(sentenceId)

			if (!sentence) {
				throw new Error(`模型返回了不存在的句子 ID：${sentenceId}`)
			}

			return sentence
		}
	)

	// 按原始文档维度重新组装压缩后的上下文
	return (
		documents
			.map((document) => ({
				id: document.id,
				title: document.title,

				// 只保留当前文档中被模型选中的句子
				content: selectedSentences
					.filter((sentence) => sentence.chunkId === document.id)
					.map((sentence) => sentence.text)
					.join('')
			}))

			// 过滤掉没有任何有效句子的文档
			.filter((document) => document.content)
	)
}

/**
 * 打印文档列表。
 *
 * title：打印区块标题
 * documents：要打印的文档列表
 * scoreName：要展示的分数字段，比如 retrievalScore 或 rerankScore
 */
function printDocuments(title, documents, scoreName) {
	console.log(`\n================ ${title} ================`)

	documents.forEach((document, index) => {
		const score = Number(document[scoreName]).toFixed(6)

		console.log(`\n${index + 1}. ${document.title}`)
		console.log(`Chunk ID：${document.id}`)
		console.log(`Score：${score}`)
		console.log(`Content：${document.content}`)
	})
}

/**
 * 构造最终交给大模型的上下文。
 *
 * 每个 Chunk 都带上 id 和 title，
 * 方便最终回答时进行引用、溯源或调试。
 */
function buildFinalContext(documents) {
	return documents
		.map(
			(document) => `[${document.id} | ${document.title}]\n${document.content}`
		)
		.join('\n\n')
}

// ================= 主流程 =================

// 打印用户问题
console.log(`用户问题：${question}`)

// 打印检索阶段召回的原始候选资料
printDocuments('当前候选资料', candidates, 'retrievalScore')

// 第一步：使用 Rerank 模型对候选资料重新排序，选出最相关的 Top4
const rerankedDocuments = await rerankDocuments(question, candidates)
printDocuments('Rerank 之后的 Top4', rerankedDocuments, 'rerankScore')

// 第二步：对 Rerank 后的 Chunk 做抽取式上下文压缩
const compressedDocuments = await compressContext(question, rerankedDocuments)

// 统计压缩前字符数
const originalLength = rerankedDocuments.reduce(
	(total, document) => total + document.content.length,
	0
)

// 统计压缩后字符数
const compressedLength = compressedDocuments.reduce(
	(total, document) => total + document.content.length,
	0
)

// 打印压缩效果
console.log('\n================ Context Compression ================')
console.log(`压缩前字符数：${originalLength}`)
console.log(`压缩后字符数：${compressedLength}`)

// 打印最终要交给大模型生成回答的上下文
console.log('\n最终交给大模型的上下文：')
console.log(buildFinalContext(compressedDocuments))

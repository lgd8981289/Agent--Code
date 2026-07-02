// 引入候选资料和用户问题
import { candidates, question } from './candidate-documents.js'

// 从环境变量中读取智谱 API Key
const apiKey = process.env.ZHIPU_API_KEY

// Rerank 模型名称，默认使用 rerank
const rerankModel = process.env.RERANK_MODEL ?? 'rerank'

/**
 * 使用 Rerank 模型对候选文档重新排序。
 *
 * @param {string} query 用户问题
 * @param {Array} documents 候选文档列表
 * @param {number} topN 返回相关性最高的前 N 条文档
 * @returns {Promise<Array>} 重新排序后的文档列表
 */
async function rerankDocuments(query, documents, topN = 4) {
	// 调用 API 前先检查环境变量中是否配置了 API Key
	if (!apiKey) {
		throw new Error('没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。')
	}

	// 调用智谱 Rerank API，对候选文档进行相关性重排序
	const response = await fetch('https://open.bigmodel.cn/api/paas/v4/rerank', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			// 使用的 Rerank 模型
			model: rerankModel,

			// 用户原始问题
			query,

			// Rerank 接收的是字符串数组，这里把标题和正文拼成完整候选文本
			documents: documents.map(
				(document) => `${document.title}\n${document.content}`
			),

			// 只返回相关性最高的前 topN 条
			top_n: topN,

			// 不让接口返回原始文档内容，后面通过 index 从本地 documents 中取回
			return_documents: false,

			// 返回原始相关性分数，方便观察排序效果
			return_raw_scores: true
		})
	})

	// 解析接口返回结果
	const result = await response.json()

	// 如果接口调用失败，抛出状态码和错误详情，方便排查问题
	if (!response.ok) {
		throw new Error(
			`Rerank API 调用失败：${response.status} ${JSON.stringify(result)}`
		)
	}

	// 防御式校验：确保接口返回了 results 数组
	if (!Array.isArray(result.results)) {
		throw new Error('Rerank API 没有返回可用的 results。')
	}

	// 根据 Rerank 返回的 index，把排序结果映射回原始文档
	return result.results.map((item) => {
		const document = documents[item.index]

		// 如果接口返回了不存在的下标，说明结果异常
		if (!document) {
			throw new Error(`Rerank API 返回了无效文档下标：${item.index}`)
		}

		return {
			// 保留原始文档信息
			...document,

			// 追加 Rerank 模型计算出的相关性分数
			rerankScore: item.relevance_score
		}
	})
}

/**
 * 打印文档列表。
 *
 * @param {string} title 当前打印区域标题
 * @param {Array} documents 要打印的文档列表
 * @param {string} scoreName 要打印的分数字段名，例如 retrievalScore 或 rerankScore
 */
function printDocuments(title, documents, scoreName) {
	console.log(`\n================ ${title} ================`)

	documents.forEach((document, index) => {
		console.log(`\n${index + 1}. ${document.title}`)
		console.log(`Chunk ID：${document.id}`)

		// 根据传入的 scoreName 动态读取分数字段，并统一保留 6 位小数
		console.log(`Score：${Number(document[scoreName]).toFixed(6)}`)

		console.log(`Content：${document.content}`)
	})
}

// 打印用户问题
console.log(`用户问题：${question}`)

// 打印检索阶段召回的原始候选资料
printDocuments('当前候选资料', candidates, 'retrievalScore')

// 使用 Rerank 模型对候选资料重新排序，默认取 Top4
const rerankedDocuments = await rerankDocuments(question, candidates)

// 打印 Rerank 之后的排序结果
printDocuments('Rerank 之后的 Top4', rerankedDocuments, 'rerankScore')

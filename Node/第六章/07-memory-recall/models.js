import { Embeddings } from '@langchain/core/embeddings'
import { ChatDeepSeek } from '@langchain/deepseek'

/** 沿用第二章的智谱接口，适配 Store 所需的两个 Embeddings 方法。 */
export class ZhipuEmbeddings extends Embeddings {
	constructor() {
		super({ maxRetries: 2 })
		this.dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 512)
		this.model = process.env.EMBEDDING_MODEL ?? 'embedding-3'
		if (!process.env.ZHIPU_API_KEY) throw new Error('缺少 ZHIPU_API_KEY。')
		if (this.model !== 'embedding-3' || ![256, 512, 1024, 2048].includes(this.dimensions)) {
			throw new Error('本例使用 embedding-3，维度可选 256、512、1024、2048。')
		}
	}

	/** 批量将记忆正文变成向量；小案例单次不超过 64 条。 */
	async embedDocuments(texts) {
		if (texts.length === 0) return []
		if (texts.length > 64) throw new Error('单次最多支持 64 条文本，请分批处理。')
		return this.caller.call(async () => {
			const response = await fetch('https://open.bigmodel.cn/api/paas/v4/embeddings', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.ZHIPU_API_KEY}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ model: this.model, dimensions: this.dimensions, input: texts }),
				signal: AbortSignal.timeout(30000)
			})
			if (!response.ok) throw new Error(`智谱 Embedding 请求失败，HTTP ${response.status}。`)
			const result = await response.json()
			const rows = result.data?.sort((a, b) => a.index - b.index)
			if (!rows || rows.length !== texts.length || rows.some((row, index) =>
				row.index !== index || !Array.isArray(row.embedding) ||
				row.embedding.length !== this.dimensions ||
				row.embedding.some((value) => !Number.isFinite(value)) ||
				!row.embedding.some((value) => value !== 0)
			)) throw new Error('Embedding 返回的数量、下标或向量维度不正确。')
			return rows.map((row) => row.embedding)
		})
	}

	/** 用户问题必须和记忆正文使用同一模型、同一维度。 */
	async embedQuery(text) {
		return (await this.embedDocuments([text]))[0]
	}
}

/** 召回完成后，使用整理好的上下文生成回答。 */
export function createAnswerModel() {
	if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY。')
	return new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 2,
		timeout: 60000,
		modelKwargs: { thinking: { type: 'disabled' } }
	})
}

import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { RetrievedChunk } from '../milvus/milvus.types.js'
import type { GroundedAnswer, RerankedChunk } from './ai.types.js'

const REFUSAL_ANSWER = '根据当前知识库资料，无法回答这个问题。'
const SUPPORTED_DIMENSIONS = new Set([256, 512, 1024, 2048])

@Injectable()
export class AiService {
	private readonly apiKey: string | undefined
	private readonly embeddingModel: string
	private readonly rerankModel: string
	private readonly chatModel: string
	private readonly dimensions: number

	constructor(private readonly config: ConfigService) {
		this.apiKey = this.config.get<string>('ZHIPU_API_KEY')?.trim()
		this.embeddingModel =
			this.config.get<string>('EMBEDDING_MODEL') ?? 'embedding-3'
		this.rerankModel = this.config.get<string>('RERANK_MODEL') ?? 'rerank'
		this.chatModel = this.config.get<string>('CHAT_MODEL') ?? 'glm-4.7-flash'
		this.dimensions = Number(
			this.config.get<string>('EMBEDDING_DIMENSIONS') ?? 512
		)
	}

	/**
	 * 校验模型调用所需配置，并返回可用的 API Key。
	 * 配置不完整时会提前终止请求，避免把无效调用发送给模型服务。
	 */
	private assertConfig(): string {
		if (!this.apiKey) {
			throw new ServiceUnavailableException(
				'没有检测到 ZHIPU_API_KEY，无法调用 Embedding、Rerank 和答案生成模型。'
			)
		}

		if (!SUPPORTED_DIMENSIONS.has(this.dimensions)) {
			throw new ServiceUnavailableException(
				'EMBEDDING_DIMENSIONS 只能是 256、512、1024 或 2048。'
			)
		}

		return this.apiKey
	}

	/**
	 * 把文本批量转换成稠密向量。
	 *
	 * @param inputs 等待向量化的 Chunk 或用户问题。
	 * @returns 与 inputs 顺序一致的向量数组。
	 */
	async createEmbeddings(inputs: string[]): Promise<number[][]> {
		const apiKey = this.assertConfig()
		const output: number[][] = []

		// Embedding API 单次最多处理 64 条数据，文档较大时需要分批调用。
		for (let start = 0; start < inputs.length; start += 64) {
			const batch = inputs.slice(start, start + 64)
			const response = await this.fetchWithRetry(
				'https://open.bigmodel.cn/api/paas/v4/embeddings',
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						model: this.embeddingModel,
						input: batch,
						dimensions: this.dimensions
					})
				}
			)
			const result = (await response.json()) as {
				data?: Array<{ index: number; embedding: number[] }>
				error?: unknown
			}

			if (!response.ok || !Array.isArray(result.data)) {
				throw new ServiceUnavailableException(
					`Embedding API 调用失败：${response.status} ${JSON.stringify(result)}`
				)
			}

			// 根据接口返回的 index 恢复输入顺序，保证 Chunk 和向量一一对应。
			output.push(
				...result.data
					.sort((first, second) => first.index - second.index)
					.map((item) => item.embedding)
			)
		}

		return output
	}

	/**
	 * 使用专用 Rerank 模型对候选 Chunk 重新排序。
	 *
	 * @param question 用户的原始问题。
	 * @param chunks 混合检索召回的候选 Chunk。
	 * @param topN 精排后保留的结果数量。
	 */
	async rerank(
		question: string,
		chunks: RetrievedChunk[],
		topN = 4
	): Promise<RerankedChunk[]> {
		if (chunks.length === 0) return []
		const apiKey = this.assertConfig()
		const response = await this.fetchWithRetry(
			'https://open.bigmodel.cn/api/paas/v4/rerank',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: this.rerankModel,
					query: question,
					documents: chunks.map(
						(chunk) => `${chunk.title}\n${chunk.content}`
					),
					top_n: Math.min(topN, chunks.length),
					return_documents: false,
					return_raw_scores: true
				})
			}
		)
		const result = (await response.json()) as {
			results?: Array<{ index: number; relevance_score: number }>
		}

		if (!response.ok || !Array.isArray(result.results)) {
			throw new ServiceUnavailableException(
				`Rerank API 调用失败：${response.status} ${JSON.stringify(result)}`
			)
		}

		return result.results.map((item) => {
			const chunk = chunks[item.index]
			if (!chunk) {
				throw new ServiceUnavailableException(
					`Rerank API 返回了无效文档下标：${item.index}`
				)
			}
			return { ...chunk, rerankScore: Number(item.relevance_score) }
		})
	}

	/**
	 * 根据精排后的 Chunk 生成有依据的回答。
	 * 没有候选资料时直接拒答，不再产生一次无意义的模型调用。
	 */
	async generateAnswer(
		question: string,
		chunks: RerankedChunk[]
	): Promise<GroundedAnswer> {
		if (chunks.length === 0) return this.createRefusal()
		const apiKey = this.assertConfig()
		const response = await this.fetchWithRetry(
			'https://open.bigmodel.cn/api/paas/v4/chat/completions',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: this.chatModel,
					messages: this.buildAnswerMessages(question, chunks),
					response_format: { type: 'json_object' },
					thinking: { type: 'disabled' },
					temperature: 0,
					stream: false
				})
			}
		)
		const result = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>
		}

		if (!response.ok) {
			throw new ServiceUnavailableException(
				`答案生成失败：${response.status} ${JSON.stringify(result)}`
			)
		}

		const content = result.choices?.[0]?.message?.content
		if (!content) {
			throw new ServiceUnavailableException('答案生成模型没有返回内容。')
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(content)
		} catch {
			throw new ServiceUnavailableException(`模型没有返回合法 JSON：${content}`)
		}

		// JSON 模式只能约束输出格式，模型返回的状态和引用仍需程序校验。
		return this.validateAnswer(parsed, chunks)
	}

	/**
	 * 构造答案生成所需的 system 和 user message。
	 * system message 同时约束拒答、引用范围和结构化输出格式。
	 */
	private buildAnswerMessages(question: string, chunks: RerankedChunk[]) {
		return [
			{
				role: 'system',
				content: `你是企业知识库问答助手，只能根据本次提供的知识库 Chunk 回答。

规则：
1. Chunk 能直接支持答案时，返回 status=answered，并给出 answer 和直接支持答案的 sourceChunkIds。
2. Chunk 无法支持答案时，不得使用模型自身知识补充或猜测。返回 status=insufficient_evidence、answer="${REFUSAL_ANSWER}"、sourceChunkIds=[]。
3. sourceChunkIds 只能从本次提供的 Chunk ID 中选择。
4. 资料给出了明确的金额、时间或条件阈值时，可以用用户提供的数据做简单比较，这仍然属于有依据的回答。
5. 回答“会不会、是否”这类问题时，第一句直接写“会”或“不会”，不要用含糊的“是的”或“不是”。
6. 只返回 JSON：{"status":"answered 或 insufficient_evidence","answer":"答案","sourceChunkIds":["Chunk ID"]}`
			},
			{
				role: 'user',
				content: `用户问题：${question}\n\n知识库 Chunk：\n${JSON.stringify(
					chunks.map((chunk) => ({
						id: chunk.chunkId,
						title: chunk.title,
						content: chunk.content
					})),
					null,
					2
				)}`
			}
		]
	}

	/**
	 * 校验模型返回的回答结构和来源 ID。
	 * 来源必须来自本次候选集，防止模型编造不存在的 Chunk 引用。
	 */
	private validateAnswer(
		value: unknown,
		chunks: RerankedChunk[]
	): GroundedAnswer {
		if (!value || typeof value !== 'object') {
			throw new ServiceUnavailableException('模型没有返回 JSON 对象。')
		}

		const answer = value as Partial<GroundedAnswer>
		if (answer.status === 'insufficient_evidence') {
			return this.createRefusal()
		}

		if (
			answer.status !== 'answered' ||
			typeof answer.answer !== 'string' ||
			!answer.answer.trim() ||
			!Array.isArray(answer.sourceChunkIds) ||
			answer.sourceChunkIds.length === 0
		) {
			throw new ServiceUnavailableException('模型返回的回答结构不完整。')
		}

		const allowedIds = new Set(chunks.map((chunk) => chunk.chunkId))
		const sourceChunkIds = [...new Set(answer.sourceChunkIds)]
		if (sourceChunkIds.some((chunkId) => !allowedIds.has(chunkId))) {
			throw new ServiceUnavailableException('模型引用了不存在的 Chunk ID。')
		}

		return {
			status: 'answered',
			answer: answer.answer.trim(),
			sourceChunkIds
		}
	}

	/**
	 * 创建系统统一的拒答结果。
	 * 拒答时不返回来源，避免无关资料被误认为答案依据。
	 */
	private createRefusal(): GroundedAnswer {
		return {
			status: 'insufficient_evidence',
			answer: REFUSAL_ANSWER,
			sourceChunkIds: []
		}
	}

	/**
	 * 发送模型请求，并对限流和服务端错误进行有限次数重试。
	 * 非重试类错误会直接返回，由调用方解析具体错误信息。
	 */
	private async fetchWithRetry(
		url: string,
		init: RequestInit,
		maxAttempts = 3
	): Promise<Response> {
		let response: Response | undefined

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			response = await fetch(url, init)
			const retryable = response.status === 429 || response.status >= 500

			if (!retryable || attempt === maxAttempts) return response
			// 使用指数退避，避免模型服务繁忙时立即连续重试。
			await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)))
		}

		throw new ServiceUnavailableException('模型服务没有返回响应。')
	}
}

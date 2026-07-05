import { Injectable } from '@nestjs/common'
import { AiService } from '../ai/ai.service.js'
import type { DemoUser } from '../auth/auth.types.js'
import { MilvusService } from '../milvus/milvus.service.js'

@Injectable()
export class KnowledgeService {
	constructor(
		private readonly ai: AiService,
		private readonly milvus: MilvusService
	) {}

	async query(user: DemoUser, question: string) {
		const startedAt = performance.now()
		const [queryVector] = await this.ai.createEmbeddings([question])
		const retrieval = await this.milvus.hybridSearch(
			user,
			question,
			queryVector
		)
		const reranked = await this.ai.rerank(question, retrieval.chunks, 4)
		const groundedAnswer = await this.ai.generateAnswer(question, reranked)
		const chunkById = new Map(
			reranked.map((chunk) => [chunk.chunkId, chunk])
		)
		const sources = groundedAnswer.sourceChunkIds.map((chunkId) => {
			const chunk = chunkById.get(chunkId)
			if (!chunk) throw new Error(`没有找到模型引用的 Chunk：${chunkId}`)

			return {
				chunkId: chunk.chunkId,
				documentId: chunk.documentId,
				title: chunk.title,
				version: chunk.version,
				chunkIndex: chunk.chunkIndex,
				sourcePath: chunk.sourcePath,
				content: chunk.content
			}
		})

		return {
			status: groundedAnswer.status,
			answer: groundedAnswer.answer,
			sources,
			pipeline: {
				permissionFilter: retrieval.filter,
				recalledCount: retrieval.chunks.length,
				rerankedCount: reranked.length,
				latencyMs: Math.round(performance.now() - startedAt),
				candidates: reranked.map((chunk, index) => ({
					rank: index + 1,
					chunkId: chunk.chunkId,
					title: chunk.title,
					version: chunk.version,
					retrievalScore: chunk.retrievalScore,
					rerankScore: chunk.rerankScore,
					content: chunk.content
				}))
			}
		}
	}
}

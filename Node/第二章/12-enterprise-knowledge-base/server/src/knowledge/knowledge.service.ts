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

	/**
	 * 执行一次完整的企业知识库问答。
	 * 流程包括问题向量化、权限内混合检索、Rerank、答案生成和来源绑定。
	 */
	async query(user: DemoUser, question: string) {
		const startedAt = performance.now()

		// 用户问题的向量用于 Dense 路线，原始文本同时用于 BM25 路线。
		// 用的全部都是 大模型的能力
		// 第一步：生成问题向量
		const [queryVector] = await this.ai.createEmbeddings([question])
		// 第二步：执行 Dense + BM25 混合检索
		const retrieval = await this.milvus.hybridSearch(
			user,
			question,
			queryVector
		)
		// 第三步：对检索结果进行 Rerank 重排
		const reranked = await this.ai.rerank(question, retrieval.chunks, 4)
		// 第四步：生成最终答案
		const groundedAnswer = await this.ai.generateAnswer(question, reranked)

		// 模型只返回 Chunk ID，最终来源信息必须从系统候选集重新绑定。
		const chunkById = new Map(reranked.map((chunk) => [chunk.chunkId, chunk]))
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
				// 检索信息返回给演示前端，方便观察权限和精排是否生效。
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

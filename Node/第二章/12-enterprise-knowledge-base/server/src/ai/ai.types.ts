import type { RetrievedChunk } from '../milvus/milvus.types.js'

export interface GroundedAnswer {
	status: 'answered' | 'insufficient_evidence'
	answer: string
	sourceChunkIds: string[]
}

export interface RerankedChunk extends RetrievedChunk {
	rerankScore: number
}

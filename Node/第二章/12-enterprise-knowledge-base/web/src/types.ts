export interface DemoUser {
	token: string
	id: string
	name: string
	tenantId: string
	tenantName: string
	departmentId: string
	departmentName: string
	role: 'admin' | 'employee'
}

export interface DocumentSummary {
	documentId: string
	title: string
	version: number
	departmentId: string
	visibility: 'company' | 'department'
	checksum: string
	sourcePath: string
	chunkCount: number
	updatedAt: number
}

export interface QuerySource {
	chunkId: string
	documentId: string
	title: string
	version: number
	chunkIndex: number
	sourcePath: string
	content: string
}

export interface QueryResult {
	status: 'answered' | 'insufficient_evidence'
	answer: string
	sources: QuerySource[]
	pipeline: {
		permissionFilter: string
		recalledCount: number
		rerankedCount: number
		latencyMs: number
		candidates: Array<{
			rank: number
			chunkId: string
			title: string
			version: number
			retrievalScore: number
			rerankScore: number
			content: string
		}>
	}
}

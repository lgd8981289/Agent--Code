export interface TextChunk {
	index: number
	content: string
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

export interface SaveDocumentInput {
	title: string
	departmentId: string
	visibility: 'company' | 'department'
	fileName: string
	content: Buffer
}

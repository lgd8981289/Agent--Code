import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AiService } from '../ai/ai.service.js'
import type { DemoUser } from '../auth/auth.types.js'
import {
	buildDocumentFilter,
	buildPermissionFilter
} from '../milvus/filter.js'
import { MilvusService } from '../milvus/milvus.service.js'
import type { KnowledgeChunkRow } from '../milvus/milvus.types.js'
import type {
	DocumentSummary,
	SaveDocumentInput,
	TextChunk
} from './document.types.js'
import { chunkMarkdown, normalizeMarkdown } from './markdown-chunker.js'

@Injectable()
export class DocumentService {
	private readonly storageRoot: string
	private readonly locks = new Map<string, Promise<void>>()

	constructor(
		private readonly config: ConfigService,
		private readonly ai: AiService,
		private readonly milvus: MilvusService
	) {
		this.storageRoot =
			this.config.get<string>('STORAGE_ROOT') ??
			path.resolve(process.cwd(), '../storage/documents')
	}

	async listDocuments(user: DemoUser): Promise<DocumentSummary[]> {
		const rows = await this.milvus.query(buildPermissionFilter(user))
		return this.summarize(rows)
	}

	async listVersions(
		user: DemoUser,
		documentId: string
	): Promise<Array<DocumentSummary & { isActive: boolean }>> {
		const rows = await this.milvus.query(
			buildDocumentFilter(user.tenantId, documentId)
		)
		if (rows.length === 0) throw new NotFoundException('没有找到这个文档。')

		const versions = new Map<number, Record<string, unknown>[]>()
		for (const row of rows) {
			const version = Number(row.version)
			const versionRows = versions.get(version) ?? []
			versionRows.push(row)
			versions.set(version, versionRows)
		}

		return [...versions.entries()]
			.map(([version, versionRows]) => ({
				...this.summarize(versionRows)[0],
				version,
				isActive: Boolean(versionRows[0].is_active)
			}))
			.sort((first, second) => second.version - first.version)
	}

	async createDocument(user: DemoUser, input: SaveDocumentInput) {
		return this.saveVersion(user, randomUUID(), input, false)
	}

	async updateDocument(
		user: DemoUser,
		documentId: string,
		input: SaveDocumentInput
	) {
		return this.saveVersion(user, documentId, input, true)
	}

	private async saveVersion(
		user: DemoUser,
		documentId: string,
		input: SaveDocumentInput,
		mustExist: boolean
	) {
		return this.withLock(`${user.tenantId}:${documentId}`, async () => {
			const markdown = normalizeMarkdown(input.content.toString('utf8'))
			if (!markdown) throw new BadRequestException('Markdown 文档不能为空。')

			const chunks = chunkMarkdown(markdown)
			if (chunks.length === 0) {
				throw new BadRequestException('文档中没有可以入库的正文。')
			}

			const history = await this.milvus.query(
				buildDocumentFilter(user.tenantId, documentId)
			)
			const activeRows = history.filter((row) => Boolean(row.is_active))

			if (mustExist && activeRows.length === 0) {
				throw new NotFoundException('没有找到需要更新的文档。')
			}

			const checksum = this.hash(markdown)
			const active = activeRows[0]
			const unchanged =
				active &&
				String(active.checksum) === checksum &&
				String(active.title) === input.title &&
				String(active.department_id) === input.departmentId &&
				String(active.visibility) === input.visibility

			if (unchanged) {
				return {
					status: 'skipped',
					reason: '文档内容和权限元数据都没有变化，不需要重复生成向量。',
					document: this.summarize(activeRows)[0]
				}
			}

			const version =
				Math.max(0, ...history.map((row) => Number(row.version))) + 1
			const sourcePath = path.posix.join(
				user.tenantId,
				documentId,
				`v${version}.md`
			)
			const vectors = await this.ai.createEmbeddings(
				chunks.map((chunk) => chunk.content)
			)
			const rows = this.createRows({
				user,
				documentId,
				version,
				checksum,
				sourcePath,
				input,
				chunks,
				vectors
			})

			await this.writeSource(sourcePath, markdown)
			await this.milvus.insertChunks(rows)

			const previous = activeRows.map((row) => ({
				chunkId: String(row.chunk_id),
				tenantId: user.tenantId
			}))
			const next = rows.map((row) => ({
				chunkId: row.chunk_id,
				tenantId: row.tenant_id
			}))

			if (previous.length > 0) await this.milvus.setActive(previous, false)
			try {
				await this.milvus.setActive(next, true)
			} catch (error) {
				if (previous.length > 0) await this.milvus.setActive(previous, true)
				throw error
			}

			return {
				status: history.length === 0 ? 'created' : 'updated',
				document: this.summarize(rows)[0]
			}
		})
	}

	private createRows(options: {
		user: DemoUser
		documentId: string
		version: number
		checksum: string
		sourcePath: string
		input: SaveDocumentInput
		chunks: TextChunk[]
		vectors: number[][]
	}): KnowledgeChunkRow[] {
		const updatedAt = Date.now()
		return options.chunks.map((chunk, index) => ({
			chunk_id: `${options.user.tenantId}:${options.documentId}:v${options.version}:${chunk.index}:${this.hash(chunk.content).slice(0, 12)}`,
			tenant_id: options.user.tenantId,
			document_id: options.documentId,
			version: options.version,
			chunk_index: chunk.index,
			is_active: false,
			department_id: options.input.departmentId,
			visibility: options.input.visibility,
			title: options.input.title,
			source_path: options.sourcePath,
			checksum: options.checksum,
			content: chunk.content,
			dense_vector: options.vectors[index],
			updated_at: updatedAt
		}))
	}

	private summarize(rows: Record<string, unknown>[]): DocumentSummary[] {
		const documents = new Map<string, Record<string, unknown>[]>()
		for (const row of rows) {
			const key = `${String(row.document_id)}:${Number(row.version)}`
			const documentRows = documents.get(key) ?? []
			documentRows.push(row)
			documents.set(key, documentRows)
		}

		return [...documents.values()]
			.map((documentRows) => {
				const first = documentRows[0]
				return {
					documentId: String(first.document_id),
					title: String(first.title),
					version: Number(first.version),
					departmentId: String(first.department_id),
					visibility: first.visibility as 'company' | 'department',
					checksum: String(first.checksum),
					sourcePath: String(first.source_path),
					chunkCount: documentRows.length,
					updatedAt: Number(first.updated_at)
				}
			})
			.sort((first, second) => second.updatedAt - first.updatedAt)
	}

	private async writeSource(relativePath: string, markdown: string) {
		const fullPath = path.join(this.storageRoot, ...relativePath.split('/'))
		await mkdir(path.dirname(fullPath), { recursive: true })
		await writeFile(fullPath, markdown, 'utf8')
	}

	private hash(text: string): string {
		return createHash('sha256').update(text).digest('hex')
	}

	private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
		while (this.locks.has(key)) await this.locks.get(key)

		let release: () => void = () => {}
		const lock = new Promise<void>((resolve) => {
			release = resolve
		})
		this.locks.set(key, lock)

		try {
			return await task()
		} finally {
			release()
			this.locks.delete(key)
		}
	}
}

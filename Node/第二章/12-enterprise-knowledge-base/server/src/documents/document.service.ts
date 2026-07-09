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
import { buildDocumentFilter, buildPermissionFilter } from '../milvus/filter.js'
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

	/**
	 * 查询当前用户有权访问的生效文档，并合并同一文档的 Chunk 信息。
	 */
	async listDocuments(user: DemoUser): Promise<DocumentSummary[]> {
		const rows = await this.milvus.query(buildPermissionFilter(user))
		return this.summarize(rows)
	}

	/**
	 * 查询一份文档的全部历史版本。
	 * 历史版本只允许管理员查看，因此这里不使用普通员工的权限 Filter。
	 */
	async listVersions(
		user: DemoUser,
		documentId: string
	): Promise<Array<DocumentSummary & { isActive: boolean }>> {
		const rows = await this.milvus.query(
			buildDocumentFilter(user.tenantId, documentId)
		)
		if (rows.length === 0) throw new NotFoundException('没有找到这个文档。')

		// 一个版本可能包含多个 Chunk，需要先按版本号重新分组。
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

	/**
	 * 创建新文档，并为它分配不会与其他文档冲突的 ID。
	 */
	async createDocument(user: DemoUser, input: SaveDocumentInput) {
		return this.saveVersion(user, randomUUID(), input, false)
	}

	/**
	 * 为已有文档发布新版本。
	 */
	async updateDocument(
		user: DemoUser,
		documentId: string,
		input: SaveDocumentInput
	) {
		return this.saveVersion(user, documentId, input, true)
	}

	/**
	 * 删除已导入文档。
	 * 这里采用软删除：保留历史版本和原始文件，只把生效 Chunk 全部置为不可检索。
	 */
	async deleteDocument(user: DemoUser, documentId: string) {
		return this.withLock(`${user.tenantId}:${documentId}`, async () => {
			const history = await this.milvus.query(
				buildDocumentFilter(user.tenantId, documentId)
			)
			if (history.length === 0)
				throw new NotFoundException('没有找到这个文档。')

			const activeRows = history.filter((row) => Boolean(row.is_active))
			if (activeRows.length === 0) {
				return {
					status: 'skipped',
					reason: '文档已经删除，不需要重复处理。',
					document: this.summarize(history)[0]
				}
			}

			await this.milvus.setActive(
				activeRows.map((row) => ({
					chunkId: String(row.chunk_id),
					tenantId: user.tenantId
				})),
				false
			)

			return {
				status: 'deleted',
				document: this.summarize(activeRows)[0]
			}
		})
	}

	/**
	 * RAG 文档入库主流程：
	 *
	 * 流程分为：
	 * 1 统一文本格式
	 * 2 切分 Chunk
	 * 3 判断是否重复入库
	 * 4 生成 Embedding 向量
	 * 5 组装 Chunk + Vector + Metadata
	 * 6 写入 Milvus
	 * 7 切换新版本 Chunk 为生效状态
	 */
	private async saveVersion(
		user: DemoUser,
		documentId: string,
		input: SaveDocumentInput,
		mustExist: boolean
	) {
		return this.withLock(`${user.tenantId}:${documentId}`, async () => {
			// 1. 读取上传的 Markdown，并统一换行、空白等格式，避免相同内容生成不同 checksum。
			const markdown = normalizeMarkdown(input.content.toString('utf8'))
			if (!markdown) throw new BadRequestException('Markdown 文档不能为空。')

			// 2. 将 Markdown 按标题、段落等结构切分成多个 Chunk，后续检索的最小单位就是 Chunk。
			const chunks = chunkMarkdown(markdown)
			if (chunks.length === 0) {
				throw new BadRequestException('文档中没有可以入库的正文。')
			}

			// 3. 查询当前文档已有的 Chunk 记录，用于判断是否重复入库，以及计算新版本号。
			const history = await this.milvus.query(
				buildDocumentFilter(user.tenantId, documentId)
			)
			const activeRows = history.filter((row) => Boolean(row.is_active))

			if (mustExist && activeRows.length === 0) {
				throw new NotFoundException('没有找到需要更新的文档。')
			}

			// 4. 计算当前 Markdown 的 checksum，用来判断文档内容是否发生变化。
			const checksum = this.hash(markdown)
			const active = activeRows[0]

			// 5. 如果内容、标题、部门、可见范围都没变，就不重复生成 Embedding，直接跳过。
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

			// 6. 生成新的文档版本号，并记录当前版本原始 Markdown 的存储路径。
			const version =
				Math.max(0, ...history.map((row) => Number(row.version))) + 1
			const sourcePath = path.posix.join(
				user.tenantId,
				documentId,
				`v${version}.md`
			)

			// 7. 为每个 Chunk 生成 Embedding 向量。
			// 注意：vectors 的顺序必须和 chunks 保持一致，方便后面按下标组装数据。
			const vectors = await this.ai.createEmbeddings(
				chunks.map((chunk) => chunk.content)
			)

			// 8. 组装 Milvus 入库数据：
			// Chunk 正文 + Embedding 向量 + tenant_id / department_id / visibility / version 等元数据。
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

			// 9. 保存原始 Markdown，方便后续审计、回溯和重新构建索引。
			await this.writeSource(sourcePath, markdown)

			// 10. 将新版本 Chunk 写入 Milvus。
			await this.milvus.insertChunks(rows)

			const previous = activeRows.map((row) => ({
				chunkId: String(row.chunk_id),
				tenantId: user.tenantId
			}))
			const next = rows.map((row) => ({
				chunkId: row.chunk_id,
				tenantId: row.tenant_id
			}))

			// 11. 切换 RAG 检索使用的生效版本：
			// 旧 Chunk 失效，新 Chunk 生效。
			if (previous.length > 0) await this.milvus.setActive(previous, false)
			try {
				await this.milvus.setActive(next, true)
			} catch (error) {
				// 如果新版本激活失败，恢复旧版本，避免线上知识库不可用。
				if (previous.length > 0) await this.milvus.setActive(previous, true)
				throw error
			}

			return {
				status: history.length === 0 ? 'created' : 'updated',
				document: this.summarize(rows)[0]
			}
		})
	}

	/**
	 * 把文档 Chunk、向量和 Metadata 组装成 Milvus 写入数据。
	 * 新数据默认不生效，待全部写入成功后再统一激活。
	 */
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

	/**
	 * 把 Chunk 行合并成文档摘要，供列表和版本接口展示。
	 */
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

	/**
	 * 按租户、文档和版本目录保存原始 Markdown 文件。
	 */
	private async writeSource(relativePath: string, markdown: string) {
		const fullPath = path.join(this.storageRoot, ...relativePath.split('/'))
		await mkdir(path.dirname(fullPath), { recursive: true })
		await writeFile(fullPath, markdown, 'utf8')
	}

	/**
	 * 生成稳定的 SHA-256，用于内容去重和 Chunk ID 构造。
	 */
	private hash(text: string): string {
		return createHash('sha256').update(text).digest('hex')
	}

	/**
	 * 对同一租户下的同一文档串行执行更新任务。
	 * 这是单进程锁，多实例部署时应替换为任务队列或分布式锁。
	 */
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

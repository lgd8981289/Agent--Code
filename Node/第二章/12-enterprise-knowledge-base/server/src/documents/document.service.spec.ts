import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { AiService } from '../ai/ai.service.js'
import type { DemoUser } from '../auth/auth.types.js'
import type { MilvusService } from '../milvus/milvus.service.js'
import type { KnowledgeChunkRow } from '../milvus/milvus.types.js'
import { DocumentService } from './document.service.js'

const user: DemoUser = {
	token: 'admin-token',
	id: 'admin-1',
	name: '管理员',
	tenantId: 'bluewhale',
	tenantName: '蓝鲸科技',
	departmentId: 'customer-service',
	departmentName: '客服部',
	role: 'admin'
}

const input = {
	title: '退款规则',
	departmentId: 'customer-service',
	visibility: 'company' as const,
	fileName: 'refund.md',
	content: Buffer.from('# 退款规则\n\n退款金额超过 2000 元时，需要人工审核。')
}

let storageRoot = ''

afterEach(async () => {
	if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
	storageRoot = ''
})

function createMilvusMock(history: Record<string, unknown>[] = []) {
	return {
		query: vi.fn().mockResolvedValue(history),
		insertChunks: vi.fn().mockResolvedValue(undefined),
		setActive: vi.fn().mockResolvedValue(undefined)
	}
}

async function createService(history: Record<string, unknown>[] = []) {
	storageRoot = await mkdtemp(path.join(tmpdir(), 'agent-documents-'))
	const config = {
		get: vi.fn((key: string) =>
			key === 'STORAGE_ROOT' ? storageRoot : undefined
		)
	} as unknown as ConfigService
	const ai = {
		createEmbeddings: vi.fn(async (texts: string[]) =>
			texts.map(() => [0.1, 0.2, 0.3])
		)
	} as unknown as AiService
	const milvus = createMilvusMock(history)

	return {
		service: new DocumentService(config, ai, milvus as unknown as MilvusService),
		ai: ai as { createEmbeddings: ReturnType<typeof vi.fn> },
		milvus
	}
}

function activeRow(overrides: Partial<KnowledgeChunkRow> = {}): KnowledgeChunkRow {
	return {
		chunk_id: 'bluewhale:doc-1:v1:0:hash',
		tenant_id: 'bluewhale',
		document_id: 'doc-1',
		version: 1,
		chunk_index: 0,
		is_active: true,
		department_id: 'customer-service',
		visibility: 'company',
		title: '退款规则',
		source_path: 'bluewhale/doc-1/v1.md',
		checksum: 'old-hash',
		content: '退款金额超过 2000 元时，需要人工审核。',
		dense_vector: [0.1, 0.2, 0.3],
		updated_at: 1,
		...overrides
	}
}

describe('DocumentService', () => {
	it('上传 Markdown 后会分块、向量化、写入 Milvus 并激活新 Chunk', async () => {
		const { service, ai, milvus } = await createService()

		const result = await service.createDocument(user, input)

		expect(result.status).toBe('created')
		expect(ai.createEmbeddings).toHaveBeenCalledWith([
			'退款规则\n\n退款金额超过 2000 元时，需要人工审核。'
		])
		expect(milvus.insertChunks).toHaveBeenCalledTimes(1)
		expect(milvus.insertChunks.mock.calls[0][0][0]).toMatchObject({
			tenant_id: 'bluewhale',
			version: 1,
			is_active: false,
			content: '退款规则\n\n退款金额超过 2000 元时，需要人工审核。'
		})
		expect(milvus.setActive).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ tenantId: 'bluewhale' })
			]),
			true
		)
	})

	it('相同文档重复上传时会通过 checksum 跳过重复向量化', async () => {
		const checksum =
			'f46a98672775e265a1676d1c24622c9b92624c7536c9d0ecea722020ab97fd07'
		const { service, ai, milvus } = await createService([
			activeRow({
				checksum,
				content: '退款规则\n\n退款金额超过 2000 元时，需要人工审核。'
			})
		])

		const result = await service.updateDocument(user, 'doc-1', input)

		expect(result.status).toBe('skipped')
		expect(ai.createEmbeddings).not.toHaveBeenCalled()
		expect(milvus.insertChunks).not.toHaveBeenCalled()
		expect(milvus.setActive).not.toHaveBeenCalled()
	})

	it('文档变化时发布新版本，并把旧版本切换为不可检索', async () => {
		const oldRow = activeRow()
		const { service, milvus } = await createService([oldRow])

		const result = await service.updateDocument(user, 'doc-1', {
			...input,
			content: Buffer.from('# 退款规则\n\n退款金额超过 3000 元时，需要人工审核。')
		})

		expect(result.status).toBe('updated')
		expect(milvus.insertChunks.mock.calls[0][0][0]).toMatchObject({
			document_id: 'doc-1',
			version: 2,
			is_active: false
		})
		expect(milvus.setActive).toHaveBeenNthCalledWith(
			1,
			[{ chunkId: oldRow.chunk_id, tenantId: 'bluewhale' }],
			false
		)
		expect(milvus.setActive).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining([
				expect.objectContaining({ tenantId: 'bluewhale' })
			]),
			true
		)
	})

	it('删除文档时保留历史数据，只关闭当前生效 Chunk', async () => {
		const oldRow = activeRow({ is_active: false, version: 1 })
		const currentRow = activeRow({
			chunk_id: 'bluewhale:doc-1:v2:0:hash',
			version: 2,
			is_active: true
		})
		const { service, milvus } = await createService([oldRow, currentRow])

		const result = await service.deleteDocument(user, 'doc-1')

		expect(result.status).toBe('deleted')
		expect(milvus.setActive).toHaveBeenCalledWith(
			[{ chunkId: currentRow.chunk_id, tenantId: 'bluewhale' }],
			false
		)
	})
})

import {
	Injectable,
	OnApplicationShutdown,
	OnModuleInit,
	ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
	DataType,
	FunctionType,
	IndexType,
	MetricType,
	MilvusClient,
	RRFRanker
} from '@zilliz/milvus2-sdk-node'
import type { DemoUser } from '../auth/auth.types.js'
import { buildPermissionFilter } from './filter.js'
import type { KnowledgeChunkRow, RetrievedChunk } from './milvus.types.js'

const OUTPUT_FIELDS = [
	'chunk_id',
	'tenant_id',
	'document_id',
	'version',
	'chunk_index',
	'is_active',
	'department_id',
	'visibility',
	'title',
	'source_path',
	'checksum',
	'content',
	'updated_at'
]

@Injectable()
export class MilvusService implements OnModuleInit, OnApplicationShutdown {
	private readonly client: MilvusClient
	private readonly collectionName: string
	private readonly dimensions: number

	constructor(private readonly config: ConfigService) {
		const configuredAddress =
			this.config.get<string>('MILVUS_ADDRESS') ?? '127.0.0.1:19530'
		const address = configuredAddress.replace(
			/(^|:\/\/)localhost(?=:\d+$)/,
			'$1127.0.0.1'
		)

		this.collectionName =
			this.config.get<string>('MILVUS_COLLECTION') ??
			'enterprise_knowledge_chunks'
		this.dimensions = Number(
			this.config.get<string>('EMBEDDING_DIMENSIONS') ?? 512
		)
		this.client = new MilvusClient({
			address,
			token: this.config.get<string>('MILVUS_TOKEN')?.trim() || undefined
		})
	}

	async onModuleInit(): Promise<void> {
		try {
			await this.client.connectPromise
			await this.ensureCollection()
		} catch (error) {
			throw new ServiceUnavailableException(
				`无法连接或初始化 Milvus：${error instanceof Error ? error.message : String(error)}`
			)
		}
	}

	async onApplicationShutdown(): Promise<void> {
		await this.client.closeConnection()
	}

	private ensureOk(response: unknown, action: string): void {
		const wrapper = response as Record<string, unknown> | undefined
		const status =
			(wrapper?.status as Record<string, unknown> | undefined) ?? wrapper
		const code = Number(status?.code ?? 0)
		const errorCode = status?.error_code

		if (code !== 0 || (errorCode && errorCode !== 'Success')) {
			throw new Error(`${action}失败：${JSON.stringify(status)}`)
		}
	}

	private async ensureCollection(): Promise<void> {
		const exists = await this.client.hasCollection({
			collection_name: this.collectionName
		})

		if (!exists.value) {
			const result = await this.client.createCollection({
				collection_name: this.collectionName,
				num_partitions: 16,
				fields: [
					{
						name: 'chunk_id',
						data_type: DataType.VarChar,
						is_primary_key: true,
						max_length: 256
					},
					{
						name: 'tenant_id',
						data_type: DataType.VarChar,
						max_length: 64,
						is_partition_key: true
					},
					{
						name: 'document_id',
						data_type: DataType.VarChar,
						max_length: 64
					},
					{ name: 'version', data_type: DataType.Int32 },
					{ name: 'chunk_index', data_type: DataType.Int32 },
					{ name: 'is_active', data_type: DataType.Bool },
					{
						name: 'department_id',
						data_type: DataType.VarChar,
						max_length: 64
					},
					{
						name: 'visibility',
						data_type: DataType.VarChar,
						max_length: 32
					},
					{
						name: 'title',
						data_type: DataType.VarChar,
						max_length: 256
					},
					{
						name: 'source_path',
						data_type: DataType.VarChar,
						max_length: 512
					},
					{
						name: 'checksum',
						data_type: DataType.VarChar,
						max_length: 64
					},
					{
						name: 'content',
						data_type: DataType.VarChar,
						max_length: 8192,
						enable_analyzer: true,
						enable_match: true,
						analyzer_params: {
							tokenizer: 'jieba',
							filter: ['removepunct']
						}
					},
					{
						name: 'dense_vector',
						data_type: DataType.FloatVector,
						dim: this.dimensions
					},
					{
						name: 'sparse_vector',
						data_type: DataType.SparseFloatVector
					},
					{ name: 'updated_at', data_type: DataType.Int64 }
				],
				functions: [
					{
						name: 'content_bm25',
						type: FunctionType.BM25,
						input_field_names: ['content'],
						output_field_names: ['sparse_vector'],
						params: {}
					}
				],
				index_params: [
					{
						field_name: 'dense_vector',
						index_type: IndexType.AUTOINDEX,
						metric_type: MetricType.COSINE
					},
					{
						field_name: 'sparse_vector',
						index_type: IndexType.SPARSE_INVERTED_INDEX,
						metric_type: MetricType.BM25,
						params: { inverted_index_algo: 'DAAT_MAXSCORE' }
					}
				]
			})

			this.ensureOk(result, '创建 Collection')
		}

		await this.client.loadCollection({
			collection_name: this.collectionName
		})
	}

	async query(filter: string, limit = 5000): Promise<Record<string, unknown>[]> {
		const result = await this.client.query({
			collection_name: this.collectionName,
			filter,
			output_fields: OUTPUT_FIELDS,
			limit
		})

		return (result.data ?? []) as Record<string, unknown>[]
	}

	async insertChunks(rows: KnowledgeChunkRow[]): Promise<void> {
		const result = await this.client.insert({
			collection_name: this.collectionName,
			data: rows
		})
		this.ensureOk(result, '写入新版本 Chunk')
		await this.client.flushSync({ collection_names: [this.collectionName] })
	}

	async setActive(
		rows: Array<{ chunkId: string; tenantId: string }>,
		isActive: boolean
	): Promise<void> {
		if (rows.length === 0) return

		const result = await this.client.upsert({
			collection_name: this.collectionName,
			partial_update: true,
			data: rows.map((row) => ({
				chunk_id: row.chunkId,
				tenant_id: row.tenantId,
				is_active: isActive
			}))
		})
		this.ensureOk(result, '切换文档版本状态')
		await this.client.flushSync({ collection_names: [this.collectionName] })
	}

	async hybridSearch(
		user: DemoUser,
		question: string,
		queryVector: number[],
		limit = 8
	): Promise<{ filter: string; chunks: RetrievedChunk[] }> {
		const filter = buildPermissionFilter(user)
		const result = await this.client.hybridSearch({
			collection_name: this.collectionName,
			data: [
				{
					anns_field: 'dense_vector',
					data: queryVector,
					limit: 12,
					expr: filter
				},
				{
					anns_field: 'sparse_vector',
					data: question,
					limit: 12,
					expr: filter
				}
			],
			rerank: RRFRanker(60),
			limit,
			output_fields: OUTPUT_FIELDS
		})

		const rows = result.results as Record<string, unknown>[]
		return {
			filter,
			chunks: rows.map((row) => this.toRetrievedChunk(row))
		}
	}

	private toRetrievedChunk(row: Record<string, unknown>): RetrievedChunk {
		return {
			chunkId: String(row.chunk_id ?? row.id),
			tenantId: String(row.tenant_id),
			documentId: String(row.document_id),
			version: Number(row.version),
			chunkIndex: Number(row.chunk_index),
			departmentId: String(row.department_id),
			visibility: row.visibility as 'company' | 'department',
			title: String(row.title),
			sourcePath: String(row.source_path),
			checksum: String(row.checksum),
			content: String(row.content),
			retrievalScore: Number(row.score ?? 0)
		}
	}
}

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
	DataType,
	IndexType,
	MetricType,
	MilvusClient
} from '@zilliz/milvus2-sdk-node'

const apiKey = process.env.ZHIPU_API_KEY
const embeddingModel = process.env.EMBEDDING_MODEL ?? 'embedding-3'
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 512)

const collectionName = process.env.MILVUS_COLLECTION ?? 'agent_course_chunks'
const chunksFile = path.resolve(
	process.cwd(),
	'../04-document-chunking/output/chunks.json'
)

const supportedDimensions = new Set([256, 512, 1024, 2048])

function ensureOk(response, action) {
	const status = response?.status ?? response
	const code = Number(status?.code ?? 0)
	const errorCode = status?.error_code

	if (code !== 0 || (errorCode && errorCode !== 'Success')) {
		throw new Error(`${action} 失败：${JSON.stringify(status)}`)
	}
}

function createClient() {
	const address = process.env.MILVUS_ADDRESS ?? 'localhost:19530'
	const token = process.env.MILVUS_TOKEN?.trim()

	return new MilvusClient({
		address,
		token: token || undefined
	})
}

async function createEmbeddings(inputs) {
	if (!apiKey) {
		throw new Error('没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。')
	}

	if (!supportedDimensions.has(dimensions)) {
		throw new Error('EMBEDDING_DIMENSIONS 只能是 256、512、1024 或 2048。')
	}

	if (inputs.length > 64) {
		throw new Error('embedding-3 单次请求的数组最大不能超过 64 条。')
	}

	const response = await fetch(
		'https://open.bigmodel.cn/api/paas/v4/embeddings',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: embeddingModel,
				input: inputs,
				dimensions
			})
		}
	)

	const result = await response.json()

	if (!response.ok) {
		throw new Error(
			`Embedding API 调用失败：${response.status} ${JSON.stringify(result)}`
		)
	}

	return result.data
		.sort((first, second) => first.index - second.index)
		.map((item) => item.embedding)
}

async function readChunks() {
	const rawText = await readFile(chunksFile, 'utf8')
	return JSON.parse(rawText)
}

async function ensureCollection(client) {
	const exists = await client.hasCollection({
		collection_name: collectionName
	})

	if (exists.value) {
		if (process.env.RESET_COLLECTION === 'true') {
			await client.dropCollection({ collection_name: collectionName })
		} else {
			await client.loadCollection({ collection_name: collectionName })
			return
		}
	}

	await client.createCollection({
		collection_name: collectionName,
		fields: [
			{
				name: 'chunk_id',
				data_type: DataType.VarChar,
				is_primary_key: true,
				max_length: 256
			},
			{
				name: 'content',
				data_type: DataType.VarChar,
				max_length: 4096
			},
			{
				name: 'source',
				data_type: DataType.VarChar,
				max_length: 512
			},
			{
				name: 'title',
				data_type: DataType.VarChar,
				max_length: 512
			},
			{
				name: 'category',
				data_type: DataType.VarChar,
				max_length: 128
			},
			{
				name: 'owner',
				data_type: DataType.VarChar,
				max_length: 128
			},
			{
				name: 'source_version',
				data_type: DataType.VarChar,
				max_length: 128
			},
			{
				name: 'chunk_index',
				data_type: DataType.Int32
			},
			{
				name: 'content_hash',
				data_type: DataType.VarChar,
				max_length: 128
			},
			{
				name: 'embedding',
				data_type: DataType.FloatVector,
				dim: dimensions
			}
		],
		index_params: [
			{
				field_name: 'embedding',
				index_type: IndexType.AUTOINDEX,
				metric_type: MetricType.COSINE
			}
		]
	})

	await client.loadCollection({ collection_name: collectionName })
}

function toRow(chunk, embedding) {
	return {
		chunk_id: chunk.chunkId,
		content: chunk.content,
		source: chunk.metadata.source,
		title: chunk.metadata.title,
		category: chunk.metadata.category,
		owner: chunk.metadata.owner,
		source_version: chunk.metadata.sourceVersion,
		chunk_index: chunk.metadata.chunkIndex,
		content_hash: chunk.metadata.contentHash,
		embedding
	}
}

async function insertChunks(client, chunks) {
	const embeddings = await createEmbeddings(chunks.map((chunk) => chunk.content))
	const rows = chunks.map((chunk, index) => toRow(chunk, embeddings[index]))

	const result = await client.insert({
		collection_name: collectionName,
		data: rows
	})

	ensureOk(result, '写入 Chunk')

	await client.flushSync({
		collection_names: [collectionName]
	})

	await client.loadCollection({
		collection_name: collectionName
	})

	return rows.length
}

function printSearchResults(results) {
	console.table(
		results.map((item, index) => ({
			rank: index + 1,
			score: Number(item.score).toFixed(6),
			chunk_id: item.chunk_id ?? item.id,
			title: item.title,
			category: item.category,
			source_version: item.source_version,
			content: String(item.content).slice(0, 60)
		}))
	)
}

async function searchQuestion(client, question, filter) {
	const [queryVector] = await createEmbeddings([question])

	const result = await client.search({
		collection_name: collectionName,
		anns_field: 'embedding',
		data: [queryVector],
		limit: 3,
		filter,
		output_fields: [
			'chunk_id',
			'content',
			'source',
			'title',
			'category',
			'owner',
			'source_version',
			'chunk_index',
			'content_hash'
		]
	})

	return result.results
}

function hash(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function createUpdatedRefundChunks() {
	const version = '2026-07-01'
	const chunks = [
		{
			content: `# 蓝鲸退款规则

普通商品签收后 7 天内可以申请退款。

生鲜商品不支持无理由退款。

退款金额超过 5000 元时，需要进入人工审核流程。

用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。`,
			chunkIndex: 1
		},
		{
			content: `如果订单命中人工审核规则，退款申请会进入客服审核队列。

客服审核通过后，系统再进入退款打款流程。`,
			chunkIndex: 2
		}
	]

	return chunks.map((chunk) => {
		const contentHash = hash(chunk.content)
		const chunkId = `refund-policy:${version}:${String(chunk.chunkIndex).padStart(
			3,
			'0'
		)}:${contentHash}`

		return {
			chunkId,
			content: chunk.content,
			metadata: {
				source: 'refund-policy.md',
				title: '蓝鲸退款规则',
				category: 'refund',
				owner: 'customer-service',
				sourceVersion: version,
				chunkIndex: chunk.chunkIndex,
				contentHash,
				chunkLength: chunk.content.length
			}
		}
	})
}

async function setup() {
	const client = createClient()
	await client.connectPromise

	await ensureCollection(client)

	const chunks = await readChunks()
	const count = await insertChunks(client, chunks)

	console.log(`已写入 Chunk 数量：${count}`)
}

async function search() {
	const client = createClient()
	await client.connectPromise
	await ensureCollection(client)

	const question = '3000 元退款需要人工审核吗？'
	const filter = 'category == "refund"'

	console.log(`用户问题：${question}`)
	console.log(`Metadata Filter：${filter}`)

	const results = await searchQuestion(client, question, filter)
	printSearchResults(results)
}

async function updateRefundRule() {
	const client = createClient()
	await client.connectPromise
	await ensureCollection(client)

	await client.delete({
		collection_name: collectionName,
		filter: 'source == "refund-policy.md"'
	})

	const updatedChunks = createUpdatedRefundChunks()
	const count = await insertChunks(client, updatedChunks)

	console.log(`退款规则已更新，新写入 Chunk 数量：${count}`)

	const question = '3000 元退款需要人工审核吗？'
	const results = await searchQuestion(client, question, 'category == "refund"')

	console.log(`更新后再次检索：${question}`)
	printSearchResults(results)
}

const action = process.argv[2]

if (action === 'setup') {
	await setup()
} else if (action === 'search') {
	await search()
} else if (action === 'update') {
	await updateRefundRule()
} else {
	console.log('请执行：node --env-file=.env milvus-rag-store.js setup|search|update')
}

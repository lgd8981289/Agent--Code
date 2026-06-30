import {
	DataType,
	FunctionType,
	IndexType,
	MetricType,
	MilvusClient,
	RRFRanker
} from '@zilliz/milvus2-sdk-node'

const apiKey = process.env.ZHIPU_API_KEY
const embeddingModel = process.env.EMBEDDING_MODEL ?? 'embedding-3'
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 512)
const configuredCollectionName = process.env.MILVUS_COLLECTION?.trim()
const collectionName =
	!configuredCollectionName ||
	configuredCollectionName === 'agent_course_chunks'
		? 'agent_course_hybrid_recall_demo'
		: configuredCollectionName

// 四种检索方案最终都只返回 Top2，保证 Recall@2 可以直接比较。
const FINAL_TOP_K = 2
const ROUTE_TOP_K = 5
const METHOD_NAMES = {
	Dense: '向量检索（Dense）',
	BM25: 'BM25 全文检索',
	Weighted: '归一化 Weighted 融合',
	RRF: 'RRF 排名融合'
}

const documents = [
	{
		id: 'refund-threshold',
		title: '退款金额审核规则',
		content:
			'# 蓝鲸退款规则\n\n普通商品签收后 7 天内可以申请退款。\n\n生鲜商品不支持无理由退款。\n\n退款金额超过 3000 元时，需要进入人工审核流程。\n\n用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。'
	},
	{
		id: 'refund-workflow',
		title: '人工审核流程',
		content:
			'人工审核流程。\n\n用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。\n\n如果订单命中人工审核规则，退款申请会进入客服审核队列。客服审核通过后，系统再进入退款打款流程。'
	},
	{
		id: 'order-cancellation',
		title: '高价值订单取消流程',
		content:
			'高价值交易申请撤销后不会立即关闭，需要转交业务专员复核，再决定是否终止订单。'
	},
	{
		id: 'refund-arrival',
		title: '退款到账时间',
		content: '退款原路退回银行卡通常需要 1 到 5 个工作日。'
	},
	{
		id: 'rule-map',
		title: '规则编号映射表',
		content: '内部规则映射：BW-RF-2026 对应蓝鲸退款规则。'
	},
	{
		id: 'rule-guide',
		title: '售后规则查询说明',
		content: '用户提供规则编号后，客服可以查询对应的售后规则名称和适用范围。'
	},
	{
		id: 'shipping-policy',
		title: '商品发货规则',
		content: '现货商品会在付款后 48 小时内发货。'
	},
	{
		id: 'invoice-policy',
		title: '发票开具规则',
		content: '订单完成后，用户可以在订单详情页申请电子发票。'
	}
]

// relevantIds 是人工标注的标准答案，用来计算 Recall@2。
const evaluationCases = [
	{
		name: '口语化退款问题',
		question:
			'这台设备花了三千五，现在想退掉，能让系统直接通过，还是必须找工作人员看一下？',
		relevantIds: ['refund-threshold', 'refund-workflow']
	},
	{
		name: '精确规则编号',
		question: 'BW-RF-2026',
		relevantIds: ['rule-map']
	},
	{
		name: '退款到账时间',
		question: '钱已经退了，什么时候能到银行卡？',
		relevantIds: ['refund-arrival']
	}
]

function ensureOk(response, action) {
	const status = response?.status ?? response
	const code = Number(status?.code ?? 0)
	const errorCode = status?.error_code

	if (code !== 0 || (errorCode && errorCode !== 'Success')) {
		throw new Error(`${action}失败：${JSON.stringify(status)}`)
	}
}

function getMilvusAddress() {
	const address = process.env.MILVUS_ADDRESS?.trim() || '127.0.0.1:19530'
	return address.replace(/(^|:\/\/)localhost(?=:\d+$)/, '$1127.0.0.1')
}

async function connectMilvus() {
	const client = new MilvusClient({
		address: getMilvusAddress(),
		token: process.env.MILVUS_TOKEN?.trim() || undefined
	})

	try {
		await client.connectPromise
		return client
	} catch {
		throw new Error(
			'无法连接 Milvus。请先执行 docker compose up -d --wait --wait-timeout 180。'
		)
	}
}

async function createEmbeddings(inputs) {
	if (!apiKey) {
		throw new Error('没有检测到 ZHIPU_API_KEY，请先配置 .env。')
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
		throw new Error(`Embedding API 调用失败：${response.status}`)
	}

	return result.data
		.sort((first, second) => first.index - second.index)
		.map((item) => item.embedding)
}

async function recreateCollection(client) {
	const exists = await client.hasCollection({
		collection_name: collectionName
	})

	if (exists.value) {
		await client.dropCollection({ collection_name: collectionName })
	}

	const result = await client.createCollection({
		collection_name: collectionName,
		fields: [
			{
				name: 'id',
				data_type: DataType.VarChar,
				is_primary_key: true,
				max_length: 128
			},
			{
				name: 'title',
				data_type: DataType.VarChar,
				max_length: 256
			},
			{
				name: 'content',
				data_type: DataType.VarChar,
				max_length: 1024,
				enable_analyzer: true,
				enable_match: true,
				analyzer_params: {
					tokenizer: 'jieba',
					filter: ['removepunct']
				}
			},
			{
				name: 'embedding',
				data_type: DataType.FloatVector,
				dim: dimensions
			},
			{
				name: 'sparse_embedding',
				data_type: DataType.SparseFloatVector
			}
		],
		functions: [
			{
				name: 'content_bm25',
				type: FunctionType.BM25,
				input_field_names: ['content'],
				output_field_names: ['sparse_embedding'],
				params: {}
			}
		],
		index_params: [
			{
				field_name: 'embedding',
				index_type: IndexType.AUTOINDEX,
				metric_type: MetricType.COSINE
			},
			{
				field_name: 'sparse_embedding',
				index_type: IndexType.SPARSE_INVERTED_INDEX,
				metric_type: MetricType.BM25,
				params: {
					inverted_index_algo: 'DAAT_MAXSCORE',
					bm25_k1: 1.2,
					bm25_b: 0.75
				}
			}
		]
	})

	ensureOk(result, '创建 Collection')
}

async function insertDocuments(client) {
	const embeddings = await createEmbeddings(
		documents.map((document) => document.content)
	)

	const result = await client.insert({
		collection_name: collectionName,
		data: documents.map((document, index) => ({
			...document,
			embedding: embeddings[index]
		}))
	})

	ensureOk(result, '写入文档')
	await client.flushSync({ collection_names: [collectionName] })
	await client.loadCollection({ collection_name: collectionName })
}

async function denseSearch(client, queryVector, limit) {
	const result = await client.search({
		collection_name: collectionName,
		anns_field: 'embedding',
		data: [queryVector],
		limit,
		output_fields: ['id', 'title', 'content']
	})

	return result.results
}

async function bm25Search(client, question, limit) {
	const result = await client.search({
		collection_name: collectionName,
		anns_field: 'sparse_embedding',
		data: [question],
		limit,
		output_fields: ['id', 'title', 'content']
	})

	return result.results
}

function normalizedWeightedRanker(weights) {
	return {
		name: 'normalized_weighted_ranker',
		type: FunctionType.RERANK,
		input_field_names: [],
		output_field_names: [],
		params: {
			reranker: 'weighted',
			weights,
			norm_score: true
		}
	}
}

async function hybridSearch(client, question, queryVector, rerank) {
	const result = await client.hybridSearch({
		collection_name: collectionName,
		data: [
			{
				anns_field: 'embedding',
				data: queryVector,
				limit: ROUTE_TOP_K
			},
			{
				anns_field: 'sparse_embedding',
				data: question,
				limit: ROUTE_TOP_K
			}
		],
		rerank,
		limit: FINAL_TOP_K,
		output_fields: ['id', 'title', 'content']
	})

	return result.results
}

function recallAtK(results, relevantIds) {
	const resultIds = new Set(results.map((item) => item.id))
	const hitCount = relevantIds.filter((id) => resultIds.has(id)).length
	return hitCount / relevantIds.length
}

function printExpectedDocuments(relevantIds) {
	const documentMap = new Map(
		documents.map((document) => [document.id, document])
	)

	console.log('\n标准答案：')
	for (const id of relevantIds) {
		const document = documentMap.get(id)
		console.log(`- ${document.title}（${document.id}）`)
		console.log(`  内容：${document.content.replaceAll('\n', ' ')}`)
	}
}

function printRouteDetails(routes, relevantIds) {
	const relevantIdSet = new Set(relevantIds)

	for (const route of routes) {
		const recall = recallAtK(route.results, relevantIds).toFixed(2)
		console.log(
			`\n---------------- ${route.name} | Recall@${FINAL_TOP_K}=${recall} ----------------`
		)

		route.results.forEach((item, index) => {
			const hitLabel = relevantIdSet.has(item.id) ? '命中标准答案' : '非标准答案'
			console.log(
				`${index + 1}. ${item.title} | ${hitLabel} | score=${Number(item.score).toFixed(6)}`
			)
			console.log(`   ID：${item.id}`)
			console.log(`   内容：${item.content.replaceAll('\n', ' ')}`)
		})
	}
}

async function evaluateCase(client, evaluationCase) {
	const [queryVector] = await createEmbeddings([evaluationCase.question])

	const denseResults = await denseSearch(client, queryVector, FINAL_TOP_K)
	const bm25Results = await bm25Search(
		client,
		evaluationCase.question,
		FINAL_TOP_K
	)
	const weightedResults = await hybridSearch(
		client,
		evaluationCase.question,
		queryVector,
		normalizedWeightedRanker([0.8, 0.2])
	)
	const rrfResults = await hybridSearch(
		client,
		evaluationCase.question,
		queryVector,
		RRFRanker(60)
	)

	const routes = [
		{ key: 'Dense', name: METHOD_NAMES.Dense, results: denseResults },
		{ key: 'BM25', name: METHOD_NAMES.BM25, results: bm25Results },
		{
			key: 'Weighted',
			name: METHOD_NAMES.Weighted,
			results: weightedResults
		},
		{ key: 'RRF', name: METHOD_NAMES.RRF, results: rrfResults }
	]

	console.log(`\n\n================ ${evaluationCase.name} ================`)
	console.log(`输入：${evaluationCase.question}`)
	printExpectedDocuments(evaluationCase.relevantIds)
	printRouteDetails(routes, evaluationCase.relevantIds)

	console.log('\n本题结果汇总：')
	console.table(
		routes.map((route) => ({
			method: route.name,
			results: route.results.map((item) => item.title).join(' -> '),
			[`Recall@${FINAL_TOP_K}`]: recallAtK(
				route.results,
				evaluationCase.relevantIds
			).toFixed(2)
		}))
	)

	return Object.fromEntries(
		routes.map((route) => [
			route.key,
			recallAtK(route.results, evaluationCase.relevantIds)
		])
	)
}

async function main() {
	const client = await connectMilvus()

	try {
		await recreateCollection(client)
		await insertDocuments(client)

		console.log(`Collection：${collectionName}`)
		console.log(`文档数量：${documents.length}`)
		console.log(
			`统一评估条件：单路 Top${FINAL_TOP_K}；混合检索每路 Top${ROUTE_TOP_K}，最终 Top${FINAL_TOP_K}`
		)

		const totals = {
			Dense: 0,
			BM25: 0,
			Weighted: 0,
			RRF: 0
		}

		for (const evaluationCase of evaluationCases) {
			const recalls = await evaluateCase(client, evaluationCase)
			for (const method of Object.keys(totals)) {
				totals[method] += recalls[method]
			}
		}

		console.log('\n整体评估结果：')
		console.table(
			Object.entries(totals).map(([method, total]) => ({
				method: METHOD_NAMES[method],
				[`平均 Recall@${FINAL_TOP_K}`]: (
					total / evaluationCases.length
				).toFixed(2)
			}))
		)
	} finally {
		await client.closeConnection()
	}
}

await main()

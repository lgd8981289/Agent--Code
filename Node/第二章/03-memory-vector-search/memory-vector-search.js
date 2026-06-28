const apiKey = process.env.ZHIPU_API_KEY
const model = process.env.EMBEDDING_MODEL ?? 'embedding-3'
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 512)

const supportedDimensions = new Set([256, 512, 1024, 2048])

// 本节的测试知识库。
// 后面接入真实文档时，这些内容会来自 Markdown、PDF、数据库或者后台系统。
const documents = [
	{
		id: 'blue-whale-refund-rule',
		title: '蓝鲸退款规则',
		content: `普通商品签收后 7 天内可以申请退款。
生鲜商品不支持无理由退款。
退款金额超过 2000 元时，需要人工审核。`
	},
	{
		id: 'refund-apply-process',
		title: '退款申请流程',
		content: `用户可以在订单详情页提交退款申请。
系统会先校验订单状态、签收时间和商品类型。
需要人工审核的退款申请，会进入客服审核队列。`
	},
	{
		id: 'shipping-policy',
		title: '商品发货规则',
		content: `现货商品将在付款后 48 小时内发货。
偏远地区可能增加 1 到 3 天配送时间。`
	},
	{
		id: 'invoice-policy',
		title: '电子发票规则',
		content: `订单完成后可以申请电子发票。
企业发票需要提供公司抬头和税号。`
	},
	{
		id: 'warranty-policy',
		title: '售后保修规则',
		content: `电器商品享受 1 年整机保修。
人为损坏、进水和自行拆机不在免费保修范围内。`
	},
	{
		id: 'coupon-policy',
		title: '优惠券使用规则',
		content: `优惠券需要在有效期内使用。
已经过期的优惠券不能恢复，也不能兑换成现金。`
	}
]

// 沿用上一节：调用 embedding-3，把文本转换成向量。
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
				model,
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

// 沿用上一节：计算两个向量的余弦相似度。
function cosineSimilarity(firstVector, secondVector) {
	if (firstVector.length !== secondVector.length) {
		throw new Error(
			`向量维度不一致：${firstVector.length} !== ${secondVector.length}`
		)
	}

	let dotProduct = 0
	let firstLength = 0
	let secondLength = 0

	for (let index = 0; index < firstVector.length; index += 1) {
		dotProduct += firstVector[index] * secondVector[index]
		firstLength += firstVector[index] ** 2
		secondLength += secondVector[index] ** 2
	}

	if (firstLength === 0 || secondLength === 0) {
		throw new Error('不能计算零向量的余弦相似度。')
	}

	return dotProduct / (Math.sqrt(firstLength) * Math.sqrt(secondLength))
}

// 本节新增：构建内存向量库。
// 也就是把每份文档都转换成向量，并和原文档放在一起。
async function buildMemoryVectorStore(rawDocuments) {
	const vectors = await createEmbeddings(
		rawDocuments.map((document) => document.content)
	)

	return rawDocuments.map((document, index) => ({
		...document,
		vector: vectors[index]
	}))
}

// 本节新增：根据用户问题检索 TopK 文档。
async function searchTopK({ store, query, topK = 3, minSimilarity = 0 }) {
	const [queryVector] = await createEmbeddings([query])

	return store
		.map((document) => {
			const similarity = cosineSimilarity(queryVector, document.vector)

			return {
				id: document.id,
				title: document.title,
				content: document.content,
				similarity,
				distance: 1 - similarity
			}
		})
		.filter((document) => {
			console.log('document.similarity：' + document.similarity)
			console.log('document.content：' + document.content)
			console.log('\n')
			return document.similarity >= minSimilarity
		})
		.sort((first, second) => second.similarity - first.similarity)
		.slice(0, topK)
}

// 本节新增：格式化打印检索结果。
function printSearchResults(results) {
	console.table(
		results.map((item, index) => ({
			rank: index + 1,
			id: item.id,
			title: item.title,
			similarity: item.similarity.toFixed(6),
			distance: item.distance.toFixed(6)
		}))
	)
}

async function main() {
	console.log(`Embedding 模型：${model}`)
	console.log(`向量维度：${dimensions}`)

	console.log('\n正在构建内存向量索引...')
	const store = await buildMemoryVectorStore(documents)
	console.log(`索引构建完成，文档数量：${store.length}`)

	const query =
		'我买的咖啡机 3000 元，现在想退货。这个订单需要人工审核吗？如果要退，具体流程怎么走？'

	// const query = '公司年会在哪办？'

	console.log('\n用户问题：')
	console.log(query)

	const results = await searchTopK({
		store,
		query,
		topK: 3,
		minSimilarity: 0
	})

	console.log('\nTopK 检索结果：')
	printSearchResults(results)

	console.log('\n准备交给模型的参考资料：')
	console.log(
		results.map((item) => `【${item.title}】\n${item.content}`).join('\n\n')
	)
}

main()

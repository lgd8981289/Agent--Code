// 从环境变量中读取智谱 API Key。
// 注意：真实项目中不要把 API Key 写死在代码里。
const apiKey = process.env.ZHIPU_API_KEY

// Embedding 模型名称，默认使用 embedding-3。
const model = process.env.EMBEDDING_MODEL ?? 'embedding-3'

// 向量维度，默认使用 512 维。
// 维度越高，表达能力通常越强，但存储和计算成本也会更高。
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 512)

// embedding-3 支持的向量维度。
// 这里提前限制一下，避免传入不合法的 dimensions。
const supportedDimensions = new Set([256, 512, 1024, 2048])

// 模拟用户问题。
// 这个问题明显和“退款规则 / 人工审核”相关。
const query = '3000 元退款需要人工审核吗？'

// 方案一：把整份售后手册当成一个检索单位。
// 这样做的问题是：一旦命中，返回的是整篇文档，里面会混入很多无关内容。
const wholeManual = {
	id: 'after-sales-manual-full',
	title: '售后手册全文',
	type: 'whole-document',
	content: `# 售后手册

## 退款规则
普通商品签收后 7 天内可以申请退款。
退款金额超过 2000 元时，需要进入人工审核流程。
用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。
如果订单命中人工审核规则，退款申请会进入客服审核队列。

## 发货规则
现货商品会在付款后 48 小时内发货。
偏远地区可能增加 1 到 3 天配送时间。
如果订单中包含预售商品，整单会按照预售商品的发货时间处理。

## 发票规则
订单完成后可以申请电子发票。
企业发票需要提供公司抬头和税号。
发票开具后会发送到用户邮箱。

## 保修规则
电器商品享受 1 年整机保修。
人为损坏、进水和自行拆机不在免费保修范围内。

## 优惠券规则
优惠券需要在有效期内使用。
已经过期的优惠券不能恢复，也不能兑换成现金。

## 会员积分规则
用户完成订单后可以获得积分。
积分可以在积分商城兑换优惠券。`
}

// 方案二：把售后手册提前拆成多个 Chunk。
// 每个 Chunk 只保存一个相对独立的规则片段。
// 这样检索时更容易命中和用户问题真正相关的内容。
const chunkDocuments = [
	{
		id: 'refund-rule-chunk',
		title: 'Chunk 1：退款规则',
		type: 'chunk',
		content: `普通商品签收后 7 天内可以申请退款。
退款金额超过 2000 元时，需要进入人工审核流程。
用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。
如果订单命中人工审核规则，退款申请会进入客服审核队列。`
	},
	{
		id: 'shipping-rule-chunk',
		title: 'Chunk 2：发货规则',
		type: 'chunk',
		content: `现货商品会在付款后 48 小时内发货。
偏远地区可能增加 1 到 3 天配送时间。
如果订单中包含预售商品，整单会按照预售商品的发货时间处理。`
	},
	{
		id: 'invoice-rule-chunk',
		title: 'Chunk 3：发票规则',
		type: 'chunk',
		content: `订单完成后可以申请电子发票。
企业发票需要提供公司抬头和税号。
发票开具后会发送到用户邮箱。`
	},
	{
		id: 'warranty-rule-chunk',
		title: 'Chunk 4：保修规则',
		type: 'chunk',
		content: `电器商品享受 1 年整机保修。
人为损坏、进水和自行拆机不在免费保修范围内。`
	},
	{
		id: 'coupon-rule-chunk',
		title: 'Chunk 5：优惠券规则',
		type: 'chunk',
		content: `优惠券需要在有效期内使用。
已经过期的优惠券不能恢复，也不能兑换成现金。`
	},
	{
		id: 'points-rule-chunk',
		title: 'Chunk 6：会员积分规则',
		type: 'chunk',
		content: `用户完成订单后可以获得积分。
积分可以在积分商城兑换优惠券。`
	}
]

/**
 * 调用智谱 Embedding API，把文本数组转换成向量数组。
 */
async function createEmbeddings(inputs) {
	if (!apiKey) {
		throw new Error('没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。')
	}

	if (!supportedDimensions.has(dimensions)) {
		throw new Error('EMBEDDING_DIMENSIONS 只能是 256、512、1024 或 2048。')
	}

	// embedding-3 单次最多支持 64 条输入。
	// 这里提前校验，避免请求发出去以后才报错。
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

	// API 返回结果中带有 index。
	// 这里先按照 index 排序，确保返回的向量顺序和 inputs 的顺序一致。
	return result.data
		.sort((first, second) => first.index - second.index)
		.map((item) => item.embedding)
}

/**
 * 计算两个向量之间的余弦相似度。
 *
 * 余弦相似度越接近 1，表示两个向量方向越接近；
 * 在语义检索中，也就表示两段文本语义越相近。
 */
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
		// 点积：衡量两个向量方向是否接近。
		dotProduct += firstVector[index] * secondVector[index]

		// 分别计算两个向量的长度。
		firstLength += firstVector[index] ** 2
		secondLength += secondVector[index] ** 2
	}

	if (firstLength === 0 || secondLength === 0) {
		throw new Error('不能计算零向量的余弦相似度。')
	}

	return dotProduct / (Math.sqrt(firstLength) * Math.sqrt(secondLength))
}

/**
 * 生成内容预览。
 * console.table 展示时，如果原文太长，会影响观察结果。
 */
function preview(text) {
	return text.replace(/\s+/g, ' ').slice(0, 58)
}

/**
 * 从向量库中检索 TopK 结果。
 *
 * queryVector：用户问题的向量
 * store：文档向量库
 * topK：返回最相似的前 K 条
 */
function searchTopK({ queryVector, store, topK }) {
	return (
		store
			.map((document) => ({
				id: document.id,
				title: document.title,
				type: document.type,
				content: document.content,
				contentLength: document.content.length,

				// 计算用户问题和当前文档之间的语义相似度。
				similarity: cosineSimilarity(queryVector, document.vector)
			}))

			// 相似度从高到低排序。
			.sort((first, second) => second.similarity - first.similarity)

			// 只取前 topK 条。
			.slice(0, topK)
	)
}

/**
 * 用表格形式打印检索结果
 */
function printResults(results) {
	console.log(
		results.map((item, index) => ({
			rank: index + 1,
			title: item.title,
			type: item.type,
			similarity: item.similarity.toFixed(6),
			contentLength: item.contentLength,
			preview: item.content
		}))
	)
}

/**
 * 把检索结果组装成准备交给模型的上下文。
 *
 * 在真实 RAG 中，这一步通常会把 TopK 资料拼进 prompt / messages 里，
 * 让模型基于这些资料回答用户问题。
 */
function buildContext(results) {
	return results
		.map((item) => `【${item.title}】\n${item.content}`)
		.join('\n\n')
}

async function main() {
	console.log(`Embedding 模型：${model}`)
	console.log(`向量维度：${dimensions}`)
	console.log('\n用户问题：')
	console.log(query)

	// 同时准备两种检索单位：
	// 1. 整份文档
	// 2. 拆分后的 Chunk
	const allDocuments = [wholeManual, ...chunkDocuments]

	// 一次性把“用户问题”和“所有文档内容”都转换成向量。
	//
	// 第一个返回值是 queryVector，对应用户问题；
	// 后面的 documentVectors，对应 allDocuments 中的每一份文档。
	const [queryVector, ...documentVectors] = await createEmbeddings([
		query,
		...allDocuments.map((document) => document.content)
	])

	// 构造一个最小版的内存向量库。
	// 每条数据中既保留原始文档信息，也保存对应的向量。
	const vectorStore = allDocuments.map((document, index) => ({
		...document,
		vector: documentVectors[index]
	}))

	// 方案一：只在“整份文档”里检索。
	// 因为只有一份完整手册，所以 TopK 返回的一定是整份手册。
	const wholeDocumentResults = searchTopK({
		queryVector,
		store: vectorStore.filter((document) => document.type === 'whole-document'),
		topK: 1
	})

	// 方案二：只在“Chunk 文档”里检索。
	// 这样可以观察模型是否能命中更具体的“退款规则 Chunk”。
	const chunkResults = searchTopK({
		queryVector,
		store: vectorStore.filter((document) => document.type === 'chunk'),
		topK: 1
	})

	console.log(
		'\n================ 方案一：整份文档作为检索单位 ================'
	)
	printResults(wholeDocumentResults)

	const wholeContext = buildContext(wholeDocumentResults)
	console.log(`准备交给模型的上下文长度：${wholeContext.length} 字`)
	console.log('可以看到，TopK 只能返回整份《售后手册》。')

	console.log('\n================ 方案二：分块后作为检索单位 ================')
	printResults(chunkResults)

	const chunkContext = buildContext(chunkResults)
	console.log(`准备交给模型的上下文长度：${chunkContext.length} 字`)
	console.log('可以看到，TopK 可以返回更接近问题的 Chunk。')

	console.log('\n================ 对比结论 ================')

	// 最后用表格对比两种检索方式的差异。
	// 这段代码想说明的是：
	// 文档分块不是为了“让模型更聪明”，而是为了让检索结果更精准、更适合放进上下文。
	console.table([
		{
			mode: '整份文档',
			topResult: wholeDocumentResults[0].title,
			contextLength: wholeContext.length,
			meaning: '命中的是整份手册，里面混着很多和问题无关的内容。'
		},
		{
			mode: '分块文档',
			topResult: chunkResults[0].title,
			contextLength: chunkContext.length,
			meaning: '命中的是更小的规则片段，更适合放进模型上下文。'
		}
	])
}

main()

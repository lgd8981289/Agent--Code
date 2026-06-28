import { knowledgeBase } from './knowledge-base.js'

const apiKey = process.env.DEEPSEEK_API_KEY
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'

/**
 * 根据用户问题，从知识库中检索相关资料
 *
 * 这里用的是一个非常简化的检索逻辑：
 * - 判断用户问题中是否包含文档的关键词
 * - 匹配到的关键词越多，分数越高
 * - 最后按分数排序，取前 limit 条资料
 */
function retrieve(question, limit = 1) {
	return (
		knowledgeBase
			.map((document) => {
				// 找出当前文档中，被用户问题命中的关键词
				const matchedKeywords = document.keywords.filter((keyword) =>
					question.includes(keyword)
				)

				return {
					...document,
					score: matchedKeywords.length,
					matchedKeywords
				}
			})
			// 只保留有关键词命中的文档
			.filter((document) => document.score > 0)

			// 分数越高，说明和用户问题越相关
			.sort((a, b) => b.score - a.score)

			// 只取前 limit 条资料
			.slice(0, limit)
	)
}

/**
 * 把检索到的文档整理成模型可以阅读的上下文
 */
function buildContext(documents) {
	if (documents.length === 0) {
		return '未提供任何企业资料。'
	}

	// 将多篇资料拼接成一段文本，作为参考资料交给模型
	return documents
		.map((document) => `[${document.title}]\n${document.content}`)
		.join('\n\n')
}

/**
 * 调用模型生成回答
 *
 * 注意：
 * 这里的模型只负责根据“参考资料”回答问题。
 * 如果资料不足，系统指令会要求模型明确说无法判断，而不是自己编造规则。
 */
async function callModel({ question, documents, demoReply }) {
	// 将文档转换成模型输入中的参考资料
	const context = buildContext(documents)

	const messages = [
		{
			role: 'system',
			content:
				'你是星河零售公司的知识助手。只能根据参考资料回答。资料不足时，必须明确回答“根据当前资料无法判断”，不要编造公司规则。'
		},
		{
			role: 'user',
			content: `参考资料：\n${context}\n\n用户问题：\n${question}`
		}
	]

	console.log('\n本次交给模型的参考资料：')
	console.log(context)

	// 如果没有配置 API Key，就不真实调用模型，直接使用演示回答
	if (!apiKey) {
		console.log('\n没有检测到 DEEPSEEK_API_KEY，使用演示回答：')
		console.log(demoReply)
		return demoReply
	}

	// 调用 DeepSeek Chat Completions API
	const response = await fetch('https://api.deepseek.com/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model,
			messages,
			stream: false
		})
	})

	// 请求失败时，把接口返回的错误信息抛出来，方便排查问题
	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`DeepSeek API 调用失败：${response.status} ${errorText}`)
	}

	const result = await response.json()

	// 取出模型最终生成的回答
	const answer = result.choices?.[0]?.message?.content

	if (!answer) {
		throw new Error('DeepSeek API 没有返回可用的回答。')
	}

	console.log('\n模型回答：')
	console.log(answer)

	return answer
}

// 用户本次提出的问题
const question =
	'用户购买了一台 3000 元的咖啡机，签收 3 天后申请退款，是否需要人工审核？'

console.log('\n================ 实验一：不提供企业资料 ================')

// 实验一：不给模型任何企业资料
// 预期结果：模型应该回答“根据当前资料无法判断”，而不是自己编造退款规则
await callModel({
	question,
	documents: [],
	demoReply: '根据当前资料无法判断。'
})

console.log('\n================ 实验二：手动补充退款规则 ================')

// 实验二：手动把退款规则传给模型
// 预期结果：模型可以根据资料判断是否需要人工审核
await callModel({
	question,
	documents: [knowledgeBase[0]],
	demoReply: '需要人工审核，因为退款金额 3000 元超过了 2000 元。'
})

console.log('\n================ 实验三：先检索，再回答 ================')

// 实验三：先根据用户问题，从知识库中检索相关资料
const retrievedDocuments = retrieve(question)

console.log('\n检索结果：')
console.table(
	retrievedDocuments.map(({ id, title, score, matchedKeywords }) => ({
		id,
		title,
		score,
		matchedKeywords: matchedKeywords.join('、')
	}))
)

// 再把检索到的资料交给模型回答
// 这就是一个非常简化版的 RAG 流程：Retrieval → Augmentation → Generation
await callModel({
	question,
	documents: retrievedDocuments,
	demoReply: '需要人工审核，因为退款金额 3000 元超过了 2000 元。'
})

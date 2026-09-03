import { ChatDeepSeek } from '@langchain/deepseek'
import { MemorySaver } from '@langchain/langgraph'
import { createAgent, summarizationMiddleware } from 'langchain'
import { measureContext, messageText } from './context.js'

const USER_MESSAGES = [
	'订单 A2048 是一台 3800 元的咖啡机，外壳破损。我还没有上传破损照片，客服说超过 3000 元需要人工审核。请只告诉我处理流程，不要替我提交退款。',
	'你们周末几点营业？',
	'电子发票一般多久可以开出来？',
	'这台咖啡机签收 3 天，外包装还在。',
	'根据前面说过的情况，这笔退款要走自动流程还是人工审核？现在还缺什么材料？不要替我提交。'
]

/** 创建当前小节使用的 DeepSeek Chat Model。 */
function createModel() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	return new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 2
	})
}

/** 创建具备自动摘要能力的短期记忆 Agent。 */
function createCompactionAgent(model) {
	return createAgent({
		model,
		tools: [],
		checkpointer: new MemorySaver(),
		systemPrompt: `你是企业售后客服。
只能使用当前 State 中的消息回答，不得猜测订单信息。
不能替用户提交退款，只能说明判断结果和还缺少的材料。`,
		middleware: [
			summarizationMiddleware({
				model,
				trigger: { messages: 8 },
				keep: { messages: 5 },
				summaryPrefix: '以下是较早对话的摘要：',
				summaryPrompt: `请压缩下面的售后对话。
必须保留已经确认的订单号、金额、商品、问题、材料状态、审核规则、用户限制和未解决事项。
不要把猜测写成事实，不要保留与当前售后问题无关的闲聊。
只输出摘要正文。

{messages}`
			})
		]
	})
}

/** 打印每轮结束后 Checkpointer 中保存的最新 State。 */
function printRound(round, state) {
	const size = measureContext(state.messages)
	const summary = state.messages.find(
		(message) => message.additional_kwargs?.lc_source === 'summarization'
	)

	console.log(`\n========== 第 ${round} 轮结束 ==========`)
	console.log(`State 消息数量：${size.messageCount}`)
	console.log(`State 文本字符数：${size.characterCount}`)
	console.log(`是否已经生成摘要：${summary ? '是' : '否'}`)

	if (summary) {
		console.log('\n自动摘要：')
		console.log(messageText(summary))
	}

	console.log('\n本轮回答：')
	console.log(messageText(state.messages.at(-1)))
}

/**
 * 连续使用同一个 thread_id 发起五轮对话。
 * 第五轮进入模型以前，消息数量达到阈值，Middleware 会压缩较早消息。
 */
async function main() {
	const model = createModel()
	const agent = createCompactionAgent(model)
	const config = {
		configurable: { thread_id: 'long-conversation-1001' }
	}

	for (const [index, content] of USER_MESSAGES.entries()) {
		const state = await agent.invoke(
			{ messages: [{ role: 'user', content }] },
			config
		)

		printRound(index + 1, state)
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

import { ChatDeepSeek } from '@langchain/deepseek'
import { createAgent, tool } from 'langchain'
import * as z from 'zod'

/**
 * 创建 DeepSeek Chat Model。
 */
function createModel() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	return new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0
	})
}

/**
 * 根据订单号查询当前处理状态。
 *
 * tool() 会把普通函数包装成 LangChain Tool：
 * - description 告诉模型这个 Tool 能做什么；
 * - schema 约束 Tool 的入参格式；
 * - 函数返回值会被 LangChain 放回 Agent 消息状态。
 */
const getOrderStatus = tool(
	async ({ orderId }) => {
		// 模拟订单系统返回的查询结果。
		return JSON.stringify({
			orderId,
			status: 'waiting_for_manual_review',
			message: '退款金额超过 2000 元，正在等待人工审核'
		})
	},
	{
		name: 'get_order_status',
		description: '根据订单号查询当前处理状态',
		schema: z.object({
			orderId: z.string().describe('订单号，例如 A1024')
		})
	}
)

/**
 * 创建 Agent，并注册可以使用的 Tool。
 *
 * createAgent 会负责 Agent Loop：
 * 模型决策 → Tool 调用 → Tool 结果回注 → 模型继续决策 → 最终回答。
 */
const agent = createAgent({
	model: createModel(),
	tools: [getOrderStatus],
	systemPrompt: '你是订单客服，只能根据工具返回的数据回答。'
})

/**
 * 启动一次 Agent Run。
 */
const result = await agent.invoke({
	messages: [
		{
			role: 'user',
			content: '查询订单 A1024 当前的处理状态'
		}
	]
})

/**
 * messages 中保存了本次 Agent Run 的消息轨迹，
 * 最后一条消息就是 Agent 最终生成的回答。
 */
const finalMessage = result.messages.at(-1)

console.log(finalMessage.content)


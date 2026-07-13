const { tools, executeToolCall } = require('./tools')
const { MODEL, callDeepSeek } = require('./deepseek-client')

/**
 * 最大模型调用轮次。
 *
 * 可以通过环境变量 MAX_TOOL_ROUNDS 调整，
 * 如果配置值不是正整数，则使用默认值 4。
 */
const configuredMaxRounds = Number(process.env.MAX_TOOL_ROUNDS || 4)

const MAX_TOOL_ROUNDS =
	Number.isInteger(configuredMaxRounds) && configuredMaxRounds > 0
		? configuredMaxRounds
		: 4

/**
 * 执行完整的 Tool Calling 调用链。
 *
 * 整体流程：
 *
 * 1. 将用户问题和工具说明发送给模型
 * 2. 模型判断是否需要调用工具
 * 3. 应用程序执行模型指定的真实工具
 * 4. 将工具执行结果追加到 messages
 * 5. 再次调用模型，让模型继续判断或生成最终答案
 *
 * 为避免模型不断调用工具，整个流程受到最大轮次限制。
 */
async function runToolCalling(question) {
	/**
	 * 保存完整对话上下文。
	 *
	 * 后续每次调用模型时，都会把：
	 * - 用户问题
	 * - 模型提出的工具调用
	 * - 工具执行结果
	 *
	 * 一起重新发送给模型。
	 */
	const messages = [
		{
			role: 'system',
			content:
				'你是星河零售的售后助手。订单信息必须通过 get_order 查询，不能猜测。判断退款时，必须先取得订单真实字段，再调用 check_refund_eligibility。请根据工具结果给出简洁结论。'
		},
		{
			role: 'user',
			content: question
		}
	]

	/**
	 * 记录每一轮模型调用的统计信息，
	 * 包括停止原因、耗时和 Token 使用量。
	 */
	const callStats = []

	console.log(`模型：${MODEL}`)
	console.log(`用户问题：${question}`)

	/**
	 * Tool Calling 本质上是一个循环。
	 *
	 * 每一轮都调用一次模型，直到：
	 * - 模型不再请求调用工具，返回最终回答
	 * - 或达到最大调用轮次
	 */
	for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
		console.log(`\n================ 第 ${round} 轮模型调用 ================`)

		// 将当前完整消息上下文和可用工具发送给模型。
		const result = await callDeepSeek({
			messages,
			tools
		})

		/**
		 * 模型可能返回一个或多个工具调用请求。
		 *
		 * 如果没有 tool_calls，通常表示模型已经准备好输出最终回答。
		 */
		const toolCalls = result.message.tool_calls || []

		// 保存本轮模型调用的统计信息。
		callStats.push({
			round,
			finishReason: result.finishReason,
			latencyMs: result.latencyMs,
			usage: result.usage
		})

		console.log(`finish_reason：${result.finishReason}`)

		/**
		 * 没有工具调用请求，说明 Tool Calling 流程结束。
		 *
		 * 此时 message.content 就是模型基于前面工具结果
		 * 生成的最终回答。
		 */
		if (toolCalls.length === 0) {
			console.log('\n最终回答：')
			console.log(result.message.content)

			console.log('\n调用统计：')
			console.dir(callStats, { depth: null })

			return
		}

		/**
		 * 将模型返回的 assistant 消息追加到对话上下文。
		 *
		 * 这条消息中包含 tool_calls，
		 * 后续的 tool 消息必须与这里的工具调用一一对应。
		 */
		messages.push({
			role: 'assistant',
			content: result.message.content ?? null,
			tool_calls: toolCalls
		})

		/**
		 * 模型一次可能提出多个工具调用请求，
		 * 应用程序需要逐个执行。
		 */
		for (const toolCall of toolCalls) {
			console.log('\n模型提出工具调用：')
			console.log(`- tool_call_id：${toolCall.id}`)
			console.log(`- 工具名称：${toolCall.function.name}`)
			console.log(`- 原始参数：${toolCall.function.arguments}`)

			/**
			 * 根据工具名称从工具注册表中找到真实函数，
			 * 然后完成参数解析、Zod 校验和函数执行。
			 */
			const toolResult = await executeToolCall(toolCall)

			console.log('应用程序执行结果：')
			console.dir(toolResult, { depth: null })

			/**
			 * 将工具执行结果以 role: tool 的消息追加到 messages。
			 *
			 * 下一轮模型调用时，模型就可以读取这条工具结果，
			 * 决定继续调用其他工具，还是生成最终答案。
			 *
			 * tool_call_id 用于告诉模型：
			 * 当前结果对应前面哪一个工具调用请求。
			 */
			messages.push({
				role: 'tool',
				tool_call_id: toolCall.id,
				content: JSON.stringify(toolResult)
			})
		}
	}

	/**
	 * 达到最大轮次后主动终止。
	 *
	 * 这是一种安全保护，防止模型因为工具调用逻辑异常，
	 * 在“模型调用 → 工具执行”之间无限循环。
	 */
	throw new Error(
		`已经达到最大工具调用轮次 ${MAX_TOOL_ROUNDS}，程序主动停止，避免无限调用。`
	)
}

/**
 * 从命令行读取用户问题。
 *
 * 例如：
 *
 * node index.js 查询订单 A2048 是否可以退款
 *
 * 如果没有传入命令行参数，则使用默认问题。
 */
const question =
	process.argv.slice(2).join(' ') ||
	'查询订单 A1024 是否满足退款条件，并告诉我是否需要人工审核。'

/**
 * 启动 Tool Calling 调用链。
 *
 * 捕获执行过程中的异常，并设置非零退出码，
 * 方便命令行或部署环境识别程序执行失败。
 */
runToolCalling(question).catch((error) => {
	console.error('\n执行失败：', error.message)
	process.exitCode = 1
})

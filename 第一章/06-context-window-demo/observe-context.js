// 读取环境变量中的模型名称。
// 如果没有单独配置，就使用 deepseek-v4-flash。
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'

// messages 保存当前对话中已经发生的所有消息。
// 每完成一轮对话，新的 user 和 assistant 消息都会继续加入这里。
const messages = [
	{
		role: 'system',
		content:
			'你是星河零售公司的退款审核助手。回答必须简洁，并且只能根据当前对话中已经提供的信息判断。'
	}
]

// 准备三轮需要发送的用户消息。
// 后两轮都需要结合前面的内容才能正确理解。
const userMessages = [
	'订单 A1024 的退款金额是 3000 元，是否需要人工审核？',
	'退款金额超过 2000 元时，需要人工审核。',
	'只回答订单编号和最终结论。'
]

if (!process.env.DEEPSEEK_API_KEY) {
	console.error('没有检测到 DEEPSEEK_API_KEY，请先在 .env 中配置。')
	process.exit(1)
}

for (const [index, userContent] of userMessages.entries()) {
	// 把用户本轮输入加入历史消息。
	messages.push({
		role: 'user',
		content: userContent
	})

	const response = await fetch('https://api.deepseek.com/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model,
			messages,

			// 这次实验不需要模型生成很长的内容。
			// 限制输出长度，可以减少实验消耗。
			max_tokens: 120,
			stream: false,
			thinking: {
				type: 'disabled'
			}
		})
	})

	const result = await response.json()

	if (!response.ok) {
		console.error('DeepSeek API 返回错误：')
		console.dir(result, { depth: null })
		process.exit(1)
	}

	const assistantMessage = result.choices[0].message
	const usage = result.usage

	console.log(`\n第 ${index + 1} 轮`)
	console.log(`用户：${userContent}`)
	console.log(`模型：${assistantMessage.content}`)

	// prompt_tokens 表示模型本轮真正收到的输入 Token 数量。
	// 随着 messages 逐渐增加，这个数字通常也会不断增加。
	console.table({
		输入消息数量: messages.length,
		输入Token: usage.prompt_tokens,
		输出Token: usage.completion_tokens,
		总Token: usage.total_tokens,
		缓存命中Token: usage.prompt_cache_hit_tokens ?? 0,
		缓存未命中Token: usage.prompt_cache_miss_tokens ?? 0,
		停止原因: result.choices[0].finish_reason
	})

	// 保存模型回答。
	// 下一轮请求时，这条 assistant 消息也会重新发送给模型。
	messages.push({
		role: 'assistant',
		content: assistantMessage.content
	})
}

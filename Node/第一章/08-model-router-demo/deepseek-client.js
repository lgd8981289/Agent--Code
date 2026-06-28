async function callDeepSeek({ route, messages }) {
	// 组装发送给 DeepSeek 的请求体
	const body = {
		model: route.model,
		messages,
		thinking: route.thinking
	}

	// 如果当前路线需要推理强度，就额外传入 reasoning_effort
	if (route.reasoning_effort) {
		body.reasoning_effort = route.reasoning_effort
	}

	// 没有配置 API Key 时，不真正调用接口，只返回请求体方便查看
	if (!process.env.DEEPSEEK_API_KEY) {
		return {
			skipped: true,
			reason: '未设置 DEEPSEEK_API_KEY，本次只打印请求体。',
			requestBody: body
		}
	}

	// 记录开始时间，用来计算接口耗时
	const startedAt = Date.now()

	// 调用 DeepSeek Chat Completions 接口
	const response = await fetch('https://api.deepseek.com/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
		},
		body: JSON.stringify(body)
	})

	// 解析接口返回结果
	const data = await response.json()

	// 如果接口调用失败，直接抛出错误
	if (!response.ok) {
		throw new Error(
			`DeepSeek 调用失败：${response.status} ${JSON.stringify(data)}`
		)
	}

	// 取出模型返回的消息内容
	const message = data.choices?.[0]?.message || {}

	// 返回整理后的调用结果
	return {
		skipped: false,
		latencyMs: Date.now() - startedAt,
		content: message.content,
		reasoningContent: message.reasoning_content,
		usage: data.usage
	}
}

module.exports = {
	callDeepSeek
}

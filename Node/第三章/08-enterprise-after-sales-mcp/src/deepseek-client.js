const apiUrl =
	process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/chat/completions'

export const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'

/** 调用支持 OpenAI Chat Completions 结构的 DeepSeek 接口。 */
export async function callDeepSeek({ messages, tools }) {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置')
	}

	const response = await fetch(apiUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model,
			messages,
			tools,
			tool_choice: 'auto',
			thinking: { type: 'disabled' },
			temperature: 0.1
		})
	})

	const data = await response.json()
	if (!response.ok) {
		throw new Error(`DeepSeek 调用失败：${response.status} ${JSON.stringify(data)}`)
	}

	const message = data.choices?.[0]?.message
	if (!message) throw new Error('DeepSeek 没有返回有效消息')
	return message
}

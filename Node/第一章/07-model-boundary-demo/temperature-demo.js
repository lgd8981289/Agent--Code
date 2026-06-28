const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'

if (!process.env.DEEPSEEK_API_KEY) {
	console.error('没有检测到 DEEPSEEK_API_KEY，请先在 .env 中配置。')
	process.exit(1)
}

const prompt = '请为退款审核助手写几句简短的欢迎语，只输出欢迎语。'

/**
 * 使用指定的 temperature 连续调用三次模型。
 */
async function runGroup(temperature) {
	console.log(`\n===== temperature = ${temperature} =====`)

	for (let index = 1; index <= 3; index += 1) {
		const response = await fetch('https://api.deepseek.com/chat/completions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model,
				messages: [
					{
						role: 'user',
						content: prompt
					}
				],
				max_tokens: 80,
				temperature,
				stream: false,

				// DeepSeek V4 默认开启思考模式。
				// 官方文档明确说明：思考模式下 temperature 和 top_p 不会生效。
				// 所以这次研究 temperature 时，需要显式关闭思考模式。
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

		console.log(`${index}. ${result.choices[0].message.content}`)
	}
}

async function main() {
	// 低 temperature：生成的内容会更加集中，几次回答可能比较相似。
	await runGroup(0.1)
	// 高 temperature：模型更容易选择原本概率较低的 Token，所以回答通常会出现更多变化。
	await runGroup(1.5)
}

main().catch((error) => {
	console.error('实验执行失败：', error)
	process.exit(1)
})

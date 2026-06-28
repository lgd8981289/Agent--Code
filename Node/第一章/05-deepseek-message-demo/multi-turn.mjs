// messages 表示当前这场对话的完整上下文。
// 大模型本身不会自动记住上一轮对话，
// 所以每次请求时，都需要把历史 messages 一起发给模型。
const messages = [
	{
		// system 消息用于设定模型的身份、任务边界和回答规则。
		// 它通常放在 messages 的第一条，用来影响后续所有对话。
		role: 'system',
		content:
			'你是星河零售公司的退款审核助手。回答时只根据当前对话中已经提供的信息判断。'
	}
]

// 从环境变量中读取模型名称。
// 如果没有配置 DEEPSEEK_MODEL，就默认使用 deepseek-v4-flash。
// 这里可以通过环境变量灵活切换模型，而不用改代码。
// deepseek-v4-flash 更便宜，deepseek-v4-pro 通常效果更强但成本更高。
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'

/**
 * 发送一轮用户消息给 DeepSeek API。
 *
 * @param {string} userContent 用户本轮输入的内容
 * @param {string} demoAssistantReply 没有配置 API Key 时使用的演示回复
 */
async function sendMessage(userContent, demoAssistantReply) {
	// 1. 把用户本轮输入加入 messages。
	//
	// 注意：
	// 这里不是只发送当前这句话，
	// 而是把当前用户输入追加到历史对话中。
	messages.push({
		role: 'user',
		content: userContent
	})

	// 2. 组装请求体。
	//
	// 这个 requestBody 就是准备发给 DeepSeek Chat Completions API 的数据。
	const requestBody = {
		// 指定使用哪个模型
		model,

		// 把完整对话上下文发给模型。
		// 这里面包含：
		// - system 设定
		// - 历史 user 消息
		// - 历史 assistant 消息
		// - 当前 user 消息
		messages,

		// stream: false 表示一次性返回完整结果。
		// 如果设置为 true，则会变成流式输出，适合聊天页面逐字显示。
		stream: false,

		// 关闭 thinking。
		// 这里表示不启用额外的推理输出能力。
		thinking: {
			type: 'disabled'
		}
	}

	// 打印本轮真正发送给 API 的 messages。
	// 这一步很适合教学，因为可以清楚看到：
	// 每一轮请求都会带上前面的历史对话。
	console.log('\n本轮准备发送给 DeepSeek API 的 messages：')
	console.dir(requestBody.messages, { depth: null })

	// 3. 如果没有配置 DEEPSEEK_API_KEY，就不真正请求 API。
	//
	// 这样做的好处是：
	// 即使本地没有 API Key，也可以通过 demoAssistantReply 演示多轮对话流程。
	if (!process.env.DEEPSEEK_API_KEY) {
		console.log('\n没有检测到 DEEPSEEK_API_KEY，使用演示回复：')
		console.log(demoAssistantReply)

		// 虽然这里没有真正调用模型，
		// 但仍然要把“演示版 assistant 回复”加入 messages。
		//
		// 因为下一轮对话仍然需要基于这一轮的 assistant 回复继续进行。
		messages.push({
			role: 'assistant',
			content: demoAssistantReply
		})

		return
	}

	// 4. 使用 fetch 调用 DeepSeek API。
	//
	// 这本质上就是一次 HTTP POST 请求。
	const httpResponse = await fetch(
		'https://api.deepseek.com/chat/completions',
		{
			method: 'POST',

			headers: {
				// Authorization 用来携带 API Key。
				// Bearer 是常见的 Token 鉴权格式。
				Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,

				// 告诉服务端：请求体是 JSON 格式。
				'Content-Type': 'application/json'
			},

			// fetch 的 body 只能发送字符串、Buffer 等数据。
			// 所以需要把 JavaScript 对象转换成 JSON 字符串。
			body: JSON.stringify(requestBody)
		}
	)

	// 5. 把 API 返回的 JSON 字符串解析成 JavaScript 对象。
	const response = await httpResponse.json()

	// 6. 判断 HTTP 请求是否成功。
	//
	// httpResponse.ok 为 false，通常表示状态码不是 2xx，
	// 例如 400、401、429、500 等。
	if (!httpResponse.ok) {
		console.error('DeepSeek API 返回错误：')
		console.dir(response, { depth: null })

		// 出错时直接退出程序。
		process.exit(1)
	}

	// 7. 从返回结果中取出模型生成的 assistant 消息。
	//
	// Chat Completions API 的结果通常放在 choices 数组中。
	// choices[0].message 就是本轮模型回复的消息对象。
	const assistantMessage = response.choices[0].message

	console.log('\nDeepSeek 回答：')
	console.log(assistantMessage.content)

	// 8. 打印本轮 Token 用量。
	//
	// usage 通常包含：
	// - prompt_tokens：输入消耗的 token
	// - completion_tokens：输出消耗的 token
	// - total_tokens：总 token
	//
	// 多轮对话越长，messages 越长，prompt_tokens 通常也会越多。
	console.log('\n本轮 Token 用量：')
	console.dir(response.usage, { depth: null })

	// 9. 把模型本轮回复加入 messages。
	//
	// 这是多轮对话最关键的一步。
	// 如果不保存 assistant 的回复，
	// 下一轮请求时，模型就看不到自己上一轮说过什么。
	messages.push({
		role: 'assistant',
		content: assistantMessage.content
	})
}

// 第一轮对话：用户只告诉模型订单金额。
// 但是此时还没有告诉模型“超过多少钱需要人工审核”的规则，
// 所以模型应该无法判断。
await sendMessage(
	'订单 A1024 的退款金额是 3000 元，是否需要人工审核？',
	'目前缺少退款规则，无法判断是否需要人工审核。'
)

// 第二轮对话：用户补充退款规则。
// 因为第一轮的订单金额还保存在 messages 中，
// 所以模型现在可以结合历史信息判断：3000 元超过 2000 元，需要人工审核。
await sendMessage(
	'退款金额超过 2000 元时，需要人工审核。',
	'根据刚刚提供的规则，订单 A1024 需要人工审核。'
)

// 第三轮对话：用户追问原因。
// 因为 messages 中已经包含：
// 1. 订单 A1024 的退款金额是 3000 元
// 2. 超过 2000 元需要人工审核
// 3. 模型上一轮已经判断需要人工审核
//
// 所以模型可以回答判断依据。
await sendMessage(
	'为什么？只回答依据。',
	'因为订单 A1024 的退款金额为 3000 元，超过了 2000 元。'
)

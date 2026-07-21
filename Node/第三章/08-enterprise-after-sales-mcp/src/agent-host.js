import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'

import { callDeepSeek, model } from './deepseek-client.js'
import { createAfterSalesClient } from './mcp-client.js'

const initialQuestion = process.argv.slice(2).join(' ').trim()
const exitCommands = new Set(['/exit', '/quit', '退出'])

/** 创建一段新的售后 Agent 对话历史。 */
export function createConversationMessages() {
	return [
		{
			role: 'system',
			content: [
				'你是企业售后 Agent。',
				'订单、物流和规则必须通过工具查询，不能编造。',
				'先调用只读工具核对事实，只有用户明确要求提交时才调用写操作。'
			].join('\n')
		}
	]
}

/**
 * 处理一轮用户对话。
 *
 * 一轮用户对话内部，模型可能连续调用多个 Tool。
 * assistant 消息和 Tool Result 都会追加到同一个 messages 数组中。
 */
export async function runAgentTurn({
	question,
	messages,
	tools,
	client,
	callModel = callDeepSeek,
	logger = console
}) {
	// 把本轮用户输入追加到对话历史，而不是重新创建 messages。
	messages.push({ role: 'user', content: question })

	for (let round = 1; round <= 8; round += 1) {
		const assistantMessage = await callModel({ messages, tools })
		messages.push(assistantMessage)

		if (!assistantMessage.tool_calls?.length) {
			logger.log(`\nAgent：${assistantMessage.content}`)
			return
		}

		for (const toolCall of assistantMessage.tool_calls) {
			const args = JSON.parse(toolCall.function.arguments || '{}')
			logger.log(`\n[Tool] ${toolCall.function.name}`)
			logger.dir(args, { depth: null })

			const result = await client.callTool({
				name: toolCall.function.name,
				arguments: args
			})

			const content = result.content?.find((item) => item.type === 'text')?.text
			logger.log(content)
			messages.push({
				role: 'tool',
				tool_call_id: toolCall.id,
				content: content ?? JSON.stringify(result.structuredContent ?? {})
			})
		}
	}
}

/**
 * 持续读取用户输入，直到用户主动退出。
 *
 * messages 在整个循环中只创建一次，因此后续问题可以引用前文中的
 * 订单号、退款原因、模型回复和 Tool Result。
 */
export async function runConversation({
	initialQuestion = '',
	messages,
	tools,
	client,
	terminal,
	callModel = callDeepSeek,
	logger = console
}) {
	let pendingQuestion = initialQuestion.trim()

	while (true) {
		const input = pendingQuestion || (await terminal.question('\n用户：'))
		pendingQuestion = ''

		const question = input.trim()
		if (!question) continue

		if (exitCommands.has(question.toLowerCase())) {
			logger.log('对话已结束。')
			return
		}

		await runAgentTurn({
			question,
			messages,
			tools,
			client,
			callModel,
			logger
		})
	}
}

/** 启动连续对话 Host。 */
export async function main() {
	const token = process.env.MCP_TOKEN ?? 'token-blue-service'
	const terminal = createInterface({ input: process.stdin, output: process.stdout })
	let client

	try {
		client = await createAfterSalesClient({
			token,
			autoConfirm: false,
			name: 'enterprise-after-sales-agent-host'
		})

		client.setRequestHandler('elicitation/create', async (request) => {
			const answer = await terminal.question(`${request.params.message}（y/n）：`)
			const confirmed = answer.trim().toLowerCase() === 'y'

			return confirmed
				? { action: 'accept', content: { confirm: true } }
				: { action: 'decline' }
		})

		const { tools: mcpTools } = await client.listTools()
		const tools = mcpTools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema
			}
		}))

		// 对话历史只在 Host 启动时创建一次。
		// 后面的每一轮用户输入、模型回复和 Tool Result 都会继续追加进来。
		const messages = createConversationMessages()

		console.log(`Host 已连接 MCP Server，模型：${model}`)
		console.log(`当前身份可发现 ${mcpTools.length} 个 Tools。`)
		console.log('现在可以连续提问，输入 /exit、/quit 或“退出”结束对话。')

		await runConversation({
			initialQuestion,
			messages,
			tools,
			client,
			terminal
		})
	} finally {
		terminal.close()
		await client?.close()
	}
}

const entryFile = process.argv[1]
if (entryFile && import.meta.url === pathToFileURL(resolve(entryFile)).href) {
	await main()
}

/**
 * 文件作用：
 * 实现命令行 Agent Host，负责调用 DeepSeek、执行 MCP Tools、
 * 保存消息历史并支持连续对话和人工确认。
 *
 * 章节定位：【本章重点】
 *
 * 建议阅读：
 * 重点理解一轮 Tool Calling 循环、Tool Result 如何写回 messages，
 * 以及为什么同一个 messages 数组能够支持连续对话。
 */
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'

import { callDeepSeek, model } from './deepseek-client.js'
import { createAfterSalesClient } from './mcp-client.js'

const initialQuestion = process.argv.slice(2).join(' ').trim()
const exitCommands = new Set(['/exit', '/quit', '退出'])

// ==================== 对话历史初始化 ====================

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

// ==================== 单轮 Agent 与 Tool Calling 循环 ====================

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

// ==================== 连续对话循环 ====================

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

// ==================== Host 启动入口 ====================

/**
 * 启动连续对话 Host。
 *
 * 主要职责：
 * 1. 创建并连接 MCP Client，处理 Server 发起的用户确认请求；
 * 2. 获取 MCP Tools，并转换成模型能够识别的工具定义；
 * 3. 创建对话历史，启动连续对话循环。
 */
export async function main() {
	const token = process.env.MCP_TOKEN ?? 'token-blue-service'

	// 创建终端输入接口，用于接收用户问题以及处理 Human-in-the-Loop 确认。
	const terminal = createInterface({
		input: process.stdin,
		output: process.stdout
	})

	let client

	try {
		/**
		 * 第一件事：创建并连接 MCP Client。
		 *
		 * Client 负责连接售后 MCP Server，
		 * 并通过 MCP 协议发现、调用 Server 暴露的能力。
		 */
		client = await createAfterSalesClient({
			token,
			autoConfirm: false,
			name: 'enterprise-after-sales-agent-host'
		})

		/**
		 * 注册 elicitation/create 请求处理器。
		 *
		 * 当 MCP Server 执行敏感操作前需要用户确认时，
		 * 会向 Client 发起 elicitation/create 请求。
		 *
		 * Host 在终端中询问用户，并把用户的选择返回给 Server。
		 */
		client.setRequestHandler('elicitation/create', async (request) => {
			const answer = await terminal.question(
				`${request.params.message}（y/n）：`
			)

			const confirmed = answer.trim().toLowerCase() === 'y'

			return confirmed
				? {
						action: 'accept',
						content: {
							confirm: true
						}
					}
				: {
						action: 'decline'
					}
		})

		/**
		 * 第二件事：发现 MCP Server 暴露的 Tools。
		 */
		const { tools: mcpTools } = await client.listTools()

		/**
		 * 把 MCP Tool 定义转换成模型 Function Calling 所需的格式。
		 *
		 * MCP 使用 inputSchema 描述参数，
		 * 模型接口使用 function.parameters 描述参数。
		 */
		const tools = mcpTools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema
			}
		}))

		/**
		 * 第三件事：创建并维护连续对话上下文。
		 *
		 * messages 只在 Host 启动时创建一次。
		 * 后续每轮用户输入、模型回复、Tool Call 和 Tool Result，
		 * 都会继续追加到同一个消息数组中。
		 */
		const messages = createConversationMessages()

		console.log(`Host 已连接 MCP Server，模型：${model}`)
		console.log(`当前身份可发现 ${mcpTools.length} 个 Tools。`)
		console.log('现在可以连续提问，输入 /exit、/quit 或“退出”结束对话。')

		/**
		 * 启动连续对话循环。
		 *
		 * runConversation 负责：
		 * - 读取用户问题；
		 * - 调用大模型；
		 * - 处理模型返回的 tool_calls；
		 * - 通过 MCP Client 调用对应 Tool；
		 * - 把 Tool Result 写回对话历史；
		 * - 再次调用模型生成最终回答。
		 */
		await runConversation({
			initialQuestion,
			messages,
			tools,
			client,
			terminal
		})
	} finally {
		/**
		 * 无论正常退出还是发生异常，都释放终端和 MCP 连接。
		 *
		 * 可选链调用可以避免 Client 尚未创建时出现关闭异常。
		 */
		terminal.close()
		await client?.close()
	}
}

const entryFile = process.argv[1]
if (entryFile && import.meta.url === pathToFileURL(resolve(entryFile)).href) {
	await main()
}

import {
	AIMessage,
	HumanMessage,
	ToolMessage,
	createAgent,
	createMiddleware,
	tool
} from 'langchain'
import { z } from 'zod'
import { ScriptedToolCallingModel } from './scripted-model.js'

const mode = process.argv[2] === 'error' ? 'error' : 'normal'

const getTask = tool(
	async ({ taskId }) => ({
		taskId,
		title: '实现任务优先级筛选',
		status: 'active'
	}),
	{
		name: 'get_task',
		description: '根据任务编号查询研发任务',
		schema: z.object({
			taskId: z.string().describe('任务编号，例如 TASK-1024')
		})
	}
)

const getTestReport = tool(
	async ({ taskId }) => ({
		taskId,
		total: 18,
		passed: 18,
		failed: 0
	}),
	{
		name: 'get_test_report',
		description: '根据任务编号查询最近一次测试报告',
		schema: z.object({
			taskId: z.string().describe('任务编号，例如 TASK-1024')
		})
	}
)

let modelRequestCount = 0

/**
 * 使用 Wrap Hook 观察 AgentNode 和 ToolNode 内部真正收到的数据。
 * Hook 只打印信息，不修改请求和返回值。
 */
const traceMiddleware = createMiddleware({
	name: 'SourceTraceMiddleware',
	wrapModelCall: async (request, handler) => {
		modelRequestCount += 1
		console.log(`\n[Model Request ${modelRequestCount}]`)
		console.log(`可用 Tool：${request.tools.map((item) => item.name).join(', ')}`)
		printMessages(request.messages)

		const response = await handler(request)

		if (AIMessage.isInstance(response)) {
			console.log(`[AIMessage ${modelRequestCount}]`)
			printAIMessage(response)
		}

		return response
	},
	wrapToolCall: async (request, handler) => {
		console.log(`\n[ToolNode] 执行 ${request.toolCall.name}`)
		console.log(`Tool Call ID：${request.toolCall.id}`)
		console.log('参数：', request.toolCall.args)

		const result = await handler(request)

		if (ToolMessage.isInstance(result)) {
			console.log('[ToolMessage]')
			console.log(`tool_call_id：${result.tool_call_id}`)
			console.log(`status：${result.status ?? 'success'}`)
			console.log(`content：${formatContent(result.content)}`)
		}

		return result
	}
})

const agent = createAgent({
	model: new ScriptedToolCallingModel({ mode }),
	tools: [getTask, getTestReport],
	middleware: [traceMiddleware]
})

console.log(`运行模式：${mode}`)

const result = await agent.invoke(
	{
		messages: [
			new HumanMessage('查询 TASK-1024 的任务状态和最近一次测试结果。')
		]
	},
	{
		recursionLimit: 12
	}
)

console.log('\n[最终 messages]')
printMessages(result.messages)

function printMessages(messages) {
	for (const [index, message] of messages.entries()) {
		const position = String(index + 1).padStart(2, '0')

		if (AIMessage.isInstance(message)) {
			const calls = message.tool_calls ?? []
			if (calls.length > 0) {
				console.log(`${position}. AIMessage → Tool Call`)
				for (const call of calls) {
					console.log(
						`    ${call.name}(${JSON.stringify(call.args)}) id=${call.id}`
					)
				}
			} else {
				console.log(`${position}. AIMessage → ${formatContent(message.content)}`)
			}
			continue
		}

		if (ToolMessage.isInstance(message)) {
			console.log(
				`${position}. ToolMessage(${message.name}) → ${formatContent(message.content)}`
			)
			console.log(`    tool_call_id=${message.tool_call_id}`)
			continue
		}

		console.log(`${position}. HumanMessage → ${formatContent(message.content)}`)
	}
}

function printAIMessage(message) {
	if (message.tool_calls?.length) {
		for (const call of message.tool_calls) {
			console.log(
				`${call.name}(${JSON.stringify(call.args)}) id=${call.id}`
			)
		}
		return
	}

	console.log(formatContent(message.content))
}

function formatContent(content) {
	const text = typeof content === 'string' ? content : JSON.stringify(content)
	const normalized = text.replace(/\s+/g, ' ').trim()
	const withoutStack = normalized.split(' at DynamicStructuredTool')[0]

	return withoutStack.length > 240
		? `${withoutStack.slice(0, 240)}...`
		: withoutStack
}

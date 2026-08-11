import { ChatDeepSeek } from '@langchain/deepseek'
import { RunnableSequence } from '@langchain/core/runnables'
import { HumanMessage, SystemMessage, ToolMessage, tool } from 'langchain'
import * as z from 'zod'

/**
 * 模拟研发任务数据。
 * getTask Tool 会根据 taskId 从这里查询任务信息。
 */
const TASKS = {
	'DEV-1024': {
		taskId: 'DEV-1024',
		title: '为任务列表增加 priority 筛选',
		status: 'in_progress',
		owner: '小明',
		dueDate: '2026-08-12'
	},
	'DEV-2048': {
		taskId: 'DEV-2048',
		title: '修复逾期任务边界判断',
		status: 'waiting_for_test',
		owner: '小李',
		dueDate: '2026-08-15'
	}
}

/**
 * 创建本章统一使用的 DeepSeek Chat Model。
 */
function createModel() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	return new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 2
	})
}

/**
 * 把 Message 的文本内容整理成适合终端打印的字符串。
 *
 * 普通文本 Message 的 content 通常是 string，
 * 多模态等场景下也可能是结构化数据。
 */
function messageText(message) {
	if (typeof message.content === 'string') {
		return message.content
	}

	return message.text || JSON.stringify(message.content, null, 2)
}

/**
 * 根据任务编号查询研发任务。
 *
 * tool() 会把普通函数包装成 LangChain Tool，
 * description 用于告诉模型这个 Tool 能做什么，
 * schema 用于约束 Tool 的输入参数。
 *
 * Zod Schema 会在真正执行函数以前完成参数校验。
 */
const getTask = tool(
	async ({ taskId }) => {
		const task = TASKS[taskId]

		if (!task) {
			return JSON.stringify({
				found: false,
				taskId,
				message: '没有找到对应的研发任务'
			})
		}

		return JSON.stringify({
			found: true,
			...task
		})
	},
	{
		name: 'get_task',
		description: '根据研发任务编号查询任务标题、状态、负责人和截止时间',
		schema: z.object({
			taskId: z
				.string()
				.regex(/^DEV-\d+$/, '任务编号必须使用 DEV-数字 的格式')
				.describe('研发任务编号，例如 DEV-1024')
		})
	}
)

/**
 * 演示最基础的 Chat Model 调用。
 *
 * 输入是一组 Message，
 * invoke() 返回模型生成的 AIMessage。
 */
async function runModelDemo() {
	const model = createModel()

	const messages = [
		new SystemMessage('你是研发任务助手，回答必须简洁。'),
		new HumanMessage('用一句话说明：为什么测试通过以后还要运行类型检查？')
	]

	// 将完整消息上下文提交给模型，等待模型一次性生成结果。
	const response = await model.invoke(messages)

	console.log('输入 Message：')
	console.log(messages.map((message) => message.constructor.name))

	console.log('\n模型返回类型：', response.constructor.name)
	console.log('回答内容：', messageText(response))

	// usage_metadata 中通常包含输入、输出以及总 Token 消耗。
	console.log('Token 统计：', response.usage_metadata)
}

/**
 * 演示 Chat Model 的流式输出。
 *
 * 与 invoke() 一次返回完整 AIMessage 不同，
 * stream() 会不断返回 AIMessageChunk。
 */
async function runStreamDemo() {
	const model = createModel()

	const stream = await model.stream([
		new SystemMessage('你是研发任务助手，回答必须简洁。'),
		new HumanMessage('用两句话解释单元测试和类型检查的区别。')
	])

	console.log('开始接收 AIMessageChunk：\n')

	// 持续读取模型返回的消息片段并立即打印。
	for await (const chunk of stream) {
		process.stdout.write(messageText(chunk))
	}

	process.stdout.write('\n')
}

/**
 * 演示直接调用 Tool。
 *
 * 这里没有大模型参与，
 * 本质上就是应用代码主动执行 getTask。
 *
 * 可以借此观察：
 * 1. Zod Schema 的参数校验；
 * 2. Tool 函数真正返回的结果。
 */
async function runToolDemo() {
	console.log('Tool 名称：', getTask.name)
	console.log('Tool 描述：', getTask.description)

	// 参数满足 Schema，正常执行 Tool。
	const result = await getTask.invoke({ taskId: 'DEV-1024' })

	console.log('\n正确参数的执行结果：')
	console.log(JSON.parse(result))

	console.log('\n错误参数的执行结果：')

	try {
		// 不满足 /^DEV-\d+$/，会在执行 Tool 函数前被 Schema 拦截。
		await getTask.invoke({ taskId: '1024' })
	} catch (error) {
		console.log(error.message)
	}
}

/**
 * 不使用 createAgent，
 * 手动实现一次完整的 Tool Calling 循环。
 *
 * 核心流程：
 *
 * 用户问题
 * → 模型决定调用哪个 Tool
 * → 应用执行 Tool
 * → ToolMessage 回传结果
 * → 模型根据结果生成最终回答
 */
async function runManualToolCallingDemo() {
	/**
	 * bindTools() 把 getTask 的名称、描述和 Schema
	 * 提供给模型，使模型获得提出 Tool Call 的能力。
	 *
	 * 注意：
	 * bindTools() 并不会自动执行 Tool。
	 */
	const modelWithTools = createModel().bindTools([getTask])

	const messages = [
		new SystemMessage(
			'你是研发任务助手。查询任务信息时必须调用 get_task，不能猜测。'
		),
		new HumanMessage('查询 DEV-1024 当前的状态、负责人和截止时间。')
	]

	/**
	 * 第一次调用模型。
	 *
	 * 此时模型不是直接查询 TASKS，
	 * 而是根据问题判断是否需要调用 get_task。
	 */
	const decision = await modelWithTools.invoke(messages)

	// 本例只处理模型提出的第一个 Tool Call。
	const toolCall = decision.tool_calls?.[0]

	if (!toolCall?.id) {
		throw new Error('模型没有生成带 ID 的 get_task Tool Call。')
	}

	console.log('模型提出的 Tool Call：')
	console.log({
		name: toolCall.name,
		args: toolCall.args,
		id: toolCall.id
	})

	/**
	 * 模型只负责“提出” Tool Call，
	 * 真正执行 getTask 的仍然是应用程序。
	 */
	const toolResult = await getTask.invoke(toolCall.args)

	/**
	 * 把 Tool 执行结果包装成 ToolMessage。
	 *
	 * tool_call_id 必须对应模型刚才提出的 Tool Call ID，
	 * 这样模型才能知道这个结果属于哪一次工具调用。
	 */
	const toolMessage = new ToolMessage({
		content: toolResult,
		tool_call_id: toolCall.id,
		name: toolCall.name
	})

	console.log('\nToolMessage：')
	console.log({
		name: toolMessage.name,
		tool_call_id: toolMessage.tool_call_id,
		content: JSON.parse(toolResult)
	})

	/**
	 * 第二次调用模型。
	 *
	 * 上下文中同时加入：
	 * - 原始 System / Human Message
	 * - 模型刚才产生的 Tool Call
	 * - Tool 返回的 ToolMessage
	 *
	 * 模型因此可以基于真实 Tool 数据生成最终答案。
	 */
	const finalResponse = await modelWithTools.invoke([
		...messages,
		decision,
		toolMessage
	])

	console.log('\n模型最终回答：')
	console.log(messageText(finalResponse))
}

/**
 * 使用 RunnableSequence 组合一条固定执行顺序的流水线。
 *
 * 与 Agent 不同：
 * RunnableSequence 中每一步的执行顺序都是开发者提前定义好的，
 * 模型不会动态决定下一步执行什么。
 */
async function runRunnableDemo() {
	const taskSummary = RunnableSequence.from([
		/**
		 * 第一步：
		 * 从整个输入中取出 taskId。
		 *
		 * 输入：
		 * { taskId: 'DEV-2048' }
		 *
		 * 输出：
		 * { taskId: 'DEV-2048' }
		 */
		({ taskId }) => ({ taskId }),

		/**
		 * 第二步：
		 * 调用 getTask Tool 查询任务详情。
		 *
		 * 上一步的输出会自动成为这一步的输入。
		 */
		getTask,

		/**
		 * 第三步：
		 * 把 Tool 返回的任务 JSON 转换成模型需要的 Message。
		 */
		(taskJson) => [
			new SystemMessage(
				'你是研发任务助手。请根据给定数据生成一句任务进度摘要。'
			),
			new HumanMessage(`任务数据：${taskJson}`)
		],

		/**
		 * 第四步：
		 * 把 Message 提交给大模型生成摘要。
		 */
		createModel(),

		/**
		 * 第五步：
		 * 从 AIMessage 中提取最终文本。
		 */
		(response) => messageText(response)
	])

	/**
	 * 启动整条 RunnableSequence。
	 *
	 * 数据会依次经过：
	 *
	 * taskId
	 * → getTask
	 * → Message
	 * → Chat Model
	 * → string
	 */
	const result = await taskSummary.invoke({ taskId: 'DEV-2048' })

	console.log('RunnableSequence 执行结果：')
	console.log(result)
}

/**
 * 根据命令行参数决定运行哪个 Demo。
 *
 * 例如：
 * node demo.js model
 * node demo.js stream
 * node demo.js tool
 * node demo.js calling
 * node demo.js runnable
 */
const command = process.argv[2]

const commands = {
	model: runModelDemo,
	stream: runStreamDemo,
	tool: runToolDemo,
	calling: runManualToolCallingDemo,
	runnable: runRunnableDemo
}

if (!commands[command]) {
	console.log('可用命令：model、stream、tool、calling、runnable')
	process.exitCode = 1
} else {
	// 执行当前命令对应的示例。
	await commands[command]()
}


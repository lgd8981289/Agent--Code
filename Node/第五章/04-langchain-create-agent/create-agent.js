import { ChatDeepSeek } from '@langchain/deepseek'
import {
	AIMessage,
	AIMessageChunk,
	ToolMessage,
	createAgent,
	tool
} from 'langchain'
import * as z from 'zod'

/**
 * 模拟研发任务系统中的任务数据。
 */
const TASKS = {
	'DEV-1024': {
		taskId: 'DEV-1024',
		title: '为任务列表增加 priority 筛选',
		status: 'in_progress',
		owner: '小明',
		dueDate: '2026-08-15',
		repository: 'task-service'
	}
}

/**
 * 模拟 CI / 测试平台生成的最新测试报告。
 *
 * repository 是任务系统与测试系统之间的关联字段：
 * Agent 需要先查询任务，拿到 repository，
 * 才能继续查询对应仓库的测试结果。
 */
const TEST_REPORTS = {
	'task-service': {
		repository: 'task-service',
		branch: 'feature/priority-filter',
		passed: 31,
		failed: 2,
		failures: [
			'priority 参数为空时，没有使用默认值',
			'priority=high 时返回了 medium 任务'
		],
		generatedAt: '2026-08-12 09:30:00'
	}
}

/**
 * 创建本节统一使用的 DeepSeek Chat Model。
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
 * 根据任务编号查询研发任务。
 *
 * 除了返回任务状态、负责人和截止时间之外，
 * 还会返回 repository，供后续查询测试报告使用。
 *
 * config.writer 可以向 Agent Stream 写入自定义事件，
 * 后续会通过 streamMode: custom 接收到这些进度信息。
 */
const getTask = tool(
	async ({ taskId }, config) => {
		// 向外部发送 Tool 执行进度，不会作为 Tool 最终结果返回给模型。
		config.writer?.({
			type: 'tool_progress',
			message: `正在从任务系统读取 ${taskId}`
		})

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
		description:
			'根据研发任务编号查询任务详情。返回的 repository 可用于继续查询该任务所在仓库的测试报告。',
		schema: z.object({
			taskId: z
				.string()
				.regex(/^DEV-\d+$/, '任务编号必须使用 DEV-数字 的格式')
				.describe('研发任务编号，例如 DEV-1024')
		})
	}
)

/**
 * 根据代码仓库名称查询最新一次自动化测试报告。
 *
 * repository 不应该由模型凭空生成，
 * 而应该来自 get_task 返回的任务数据。
 */
const getLatestTestReport = tool(
	async ({ repository }, config) => {
		// 将当前 Tool 的执行阶段通过 custom stream 暴露出去。
		config.writer?.({
			type: 'tool_progress',
			message: `正在读取 ${repository} 的最新测试报告`
		})

		const report = TEST_REPORTS[repository]

		if (!report) {
			return JSON.stringify({
				found: false,
				repository,
				message: '没有找到对应仓库的测试报告'
			})
		}

		return JSON.stringify({
			found: true,
			...report
		})
	},
	{
		name: 'get_latest_test_report',
		description: '根据代码仓库名称查询该仓库最新一次自动化测试报告',
		schema: z.object({
			repository: z
				.string()
				.min(1)
				.describe('代码仓库名称，必须来自 get_task 返回的 repository')
		})
	}
)

/**
 * 创建研发任务交付风险分析 Agent。
 *
 * 本例存在明确的数据依赖：
 *
 * get_task
 *    ↓ repository
 * get_latest_test_report
 *
 * 第二次 Tool 调用所需的 repository，
 * 只有第一次 Tool 执行完成之后才能得到。
 *
 * 因此整个 Agent Run 会经历多轮：
 *
 * Model → Tool → Model → Tool → Model → Final Answer
 */
const agent = createAgent({
	model: createModel(),
	tools: [getTask, getLatestTestReport],
	systemPrompt: `你是研发任务交付风险分析 Agent。

分析任务是否能够按期交付时，必须遵守下面的流程：

1. 先调用 get_task 查询任务状态、截止时间和 repository。
2. 再使用 get_task 返回的 repository 调用 get_latest_test_report。
3. 只有同时拿到任务详情和测试报告，才能给出交付风险结论。
4. 只能根据 Tool 返回的数据回答，不得补充不存在的信息。

最终回答需要包含：风险等级、判断依据和处理建议。`
})

/**
 * 本次 Agent Run 的用户问题。
 */
const question = '分析研发任务 DEV-1024 是否存在延期风险，并给出处理建议。'

const input = {
	messages: [
		{
			role: 'user',
			content: question
		}
	]
}

/**
 * 从 Message 或流式 MessageChunk 中提取文本内容。
 *
 * 完整 Message 的 content 通常直接是字符串，
 * 流式消息则可以通过 text 获取当前文本片段。
 */
function messageText(message) {
	if (typeof message.content === 'string') {
		return message.content
	}

	return message.text || ''
}

/**
 * 尝试把 Tool 返回的 JSON 字符串恢复成 JavaScript 对象。
 *
 * ToolMessage 本质上仍然携带文本内容，
 * 转成对象以后更方便在控制台观察返回的数据结构。
 */
function parseToolResult(message) {
	const content = messageText(message)

	try {
		return JSON.parse(content)
	} catch {
		return content
	}
}

/**
 * 判断当前消息是不是模型生成的消息。
 *
 * updates 模式通常可能得到完整 AIMessage，
 * messages 流式模式下则主要得到 AIMessageChunk。
 */
function isAIMessageLike(message) {
	return message instanceof AIMessage || message instanceof AIMessageChunk
}

/**
 * 处理 updates 模式返回的状态增量。
 *
 * updates 关注的是：
 *
 * “Agent Runtime 的某个节点，本轮向 State 新增了什么？”
 *
 * 这里把新增 Message 保存到 trajectory，
 * 同时打印模型 Tool Call、Tool 执行完成以及最终回答等关键节点。
 */
function handleUpdate(update, trajectory) {
	for (const [nodeName, stateUpdate] of Object.entries(update)) {
		for (const message of stateUpdate.messages ?? []) {
			// 保存本轮新增 Message，后续统一打印完整执行轨迹。
			trajectory.push(message)

			/**
			 * AIMessage 中存在 tool_calls，
			 * 说明模型当前没有直接回答，而是决定调用 Tool。
			 */
			if (isAIMessageLike(message) && message.tool_calls?.length) {
				for (const call of message.tool_calls) {
					console.log(
						`[updates/${nodeName}] 模型请求调用 ${call.name}(${JSON.stringify(call.args)})`
					)
				}
				continue
			}

			/**
			 * ToolMessage 表示 Tool 已经执行完成，
			 * Tool 返回的数据也已经重新写入 Agent State，
			 * 下一轮模型调用可以读取这份 Observation。
			 */
			if (message instanceof ToolMessage) {
				console.log(
					`[updates/${nodeName}] ${message.name} 执行完成，结果已写回 Agent State`
				)
				continue
			}

			/**
			 * 模型返回 AIMessage，但没有继续产生 Tool Call，
			 * 通常意味着模型已经拿到足够信息并生成最终答案。
			 */
			if (isAIMessageLike(message)) {
				console.log(`[updates/${nodeName}] 模型没有继续调用 Tool，本次运行结束`)
			}
		}
	}
}

/**
 * 按时间顺序打印一次 Agent Run 的 Message 轨迹。
 *
 * 可以直观看到：
 *
 * HumanMessage
 * → AIMessage(Tool Call)
 * → ToolMessage
 * → AIMessage(Tool Call)
 * → ToolMessage
 * → AIMessage(Final Answer)
 */
function printTrajectory(trajectory) {
	console.log('\n\n========== 最终 Message 轨迹 ==========')
	console.log(`01. HumanMessage：${question}`)

	trajectory.forEach((message, index) => {
		const number = String(index + 2).padStart(2, '0')

		// 模型决定调用一个或多个 Tool。
		if (isAIMessageLike(message) && message.tool_calls?.length) {
			const calls = message.tool_calls
				.map(({ name, args }) => `${name}(${JSON.stringify(args)})`)
				.join('、')

			console.log(`${number}. AIMessage：${calls}`)
			return
		}

		// Tool 执行结果作为 ToolMessage 回写到上下文。
		if (message instanceof ToolMessage) {
			console.log(`${number}. ToolMessage：${message.name}`)
			console.dir(parseToolResult(message), { depth: null })
			return
		}

		// 不包含 Tool Call 的 AIMessage，即最终自然语言回答。
		if (isAIMessageLike(message)) {
			console.log(`${number}. AIMessage：最终回答`)
		}
	})
}

/**
 * 执行一次完整的 Agent Run。
 *
 * 本例同时订阅三种流：
 *
 * updates：
 *   观察 Agent Runtime 各节点对 State 的增量更新。
 *
 * messages：
 *   观察模型生成 Token / MessageChunk 的流式输出。
 *
 * custom：
 *   接收 Tool 内通过 config.writer 主动发送的自定义进度事件。
 *
 * 三种 Stream 观察的是同一次 Agent Run，
 * 只是观察维度不同。
 */
async function runDemo() {
	const trajectory = []

	// 已经执行完成的 Tool 数量。
	let completedTools = 0

	// 标记最终回答是否已经开始输出。
	let answerStarted = false

	console.log(`用户问题：${question}\n`)
	console.log('========== Agent Runtime 开始执行 ==========')

	const stream = await agent.stream(input, {
		streamMode: ['updates', 'messages', 'custom']
	})

	for await (const [mode, chunk] of stream) {
		/**
		 * updates：观察 Runtime 状态变化。
		 */
		if (mode === 'updates') {
			if (answerStarted) {
				process.stdout.write('\n')
			}

			handleUpdate(chunk, trajectory)

			// 根据轨迹中的 ToolMessage 数量判断已经完成了几次 Tool 调用。
			completedTools = trajectory.filter(
				(message) => message instanceof ToolMessage
			).length

			continue
		}

		/**
		 * custom：接收 Tool 通过 config.writer 发出的执行进度。
		 */
		if (mode === 'custom') {
			console.log(`[custom] ${chunk.message}`)
			continue
		}

		/**
		 * messages：接收模型实时生成的 MessageChunk。
		 *
		 * 前两轮模型主要生成 Tool Call，
		 * 并不是面向用户的最终自然语言回答。
		 *
		 * 因此这里等待两个 Tool 都执行完成以后，
		 * 才开始把模型最终回答实时输出到终端。
		 */
		if (mode === 'messages') {
			const [messageChunk] = chunk

			if (!(messageChunk instanceof AIMessageChunk) || completedTools < 2) {
				continue
			}

			const text = messageText(messageChunk)

			if (!text) {
				continue
			}

			if (!answerStarted) {
				answerStarted = true
				process.stdout.write('\n[messages] 模型最终回答：\n')
			}

			// 逐 Chunk 输出，实现最终答案的打字机式流式效果。
			process.stdout.write(text)
		}
	}

	// Agent Run 完成后，再统一输出完整 Message 执行轨迹。
	printTrajectory(trajectory)
}

await runDemo()

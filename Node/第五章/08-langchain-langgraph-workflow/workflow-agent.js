import { ChatDeepSeek } from '@langchain/deepseek'
import {
	END,
	START,
	ReducedValue,
	StateGraph,
	StateSchema
} from '@langchain/langgraph'
import { createAgent, tool, toolStrategy } from 'langchain'
import * as z from 'zod'

/**
 * 模拟研发任务系统。
 *
 * DEV-1024 需要继续分析交付风险；
 * DEV-2048 已经完成，不应该继续消耗模型调用。
 */
const TASKS = {
	'DEV-1024': {
		taskId: 'DEV-1024',
		title: '为任务列表增加 priority 筛选',
		status: 'in_progress',
		owner: '小明',
		dueDate: '2026-08-20',
		repository: 'task-service'
	},
	'DEV-2048': {
		taskId: 'DEV-2048',
		title: '修复导出文件名称乱码问题',
		status: 'completed',
		owner: '小李',
		dueDate: '2026-08-12',
		repository: 'export-service'
	}
}

const TEST_REPORTS = {
	'task-service': {
		repository: 'task-service',
		passed: 31,
		failed: 2,
		failures: [
			'priority 参数为空时，没有使用默认值',
			'priority=high 时返回了 medium 任务'
		]
	}
}

const FAILURE_DETAILS = {
	'task-service': {
		repository: 'task-service',
		errorType: 'AssertionError',
		location: 'src/tasks/task.service.spec.ts:84',
		actual: 'medium',
		expected: 'high'
	}
}

const TaskSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	status: z.enum(['in_progress', 'completed']),
	owner: z.string(),
	dueDate: z.string(),
	repository: z.string()
})

const RiskAnalysisSchema = z.object({
	taskId: z.string(),
	riskLevel: z.enum(['low', 'medium', 'high']),
	summary: z.string(),
	evidence: z.array(z.string()).min(2),
	suggestions: z.array(z.string()).min(1)
})

const WorkflowResultSchema = z.object({
	status: z.enum(['blocked', 'review', 'completed', 'missing']),
	summary: z.string(),
	nextAction: z.string()
})

/**
 * 外层 Workflow 使用的业务 State。
 *
 * 这里不保存 Agent 的完整 messages，只保存业务流程真正需要的数据。
 */
const DeliveryWorkflowState = new StateSchema({
	taskId: z.string(),
	task: TaskSchema.nullable().default(null),
	riskAnalysis: RiskAnalysisSchema.nullable().default(null),
	agentToolPath: z.array(z.string()).default(() => []),
	result: WorkflowResultSchema.nullable().default(null),
	executionPath: new ReducedValue(
		z.array(z.string()).default(() => []),
		{
			inputSchema: z.string(),
			reducer: (current, nodeName) => [...current, nodeName]
		}
	)
})

/**
 * 查询最新测试报告。
 */
const getLatestTestReport = tool(
	async ({ repository }) => {
		console.log(`[Tool] get_latest_test_report：${repository}`)
		const report = TEST_REPORTS[repository]

		return JSON.stringify(
			report ?? {
				repository,
				found: false,
				message: '没有找到对应仓库的测试报告'
			}
		)
	},
	{
		name: 'get_latest_test_report',
		description: '查询指定代码仓库的最新自动化测试报告',
		schema: z.object({
			repository: z.string().describe('研发任务所属的代码仓库')
		})
	}
)

/**
 * 测试失败时，进一步查询失败位置和断言差异。
 */
const getFailureDetail = tool(
	async ({ repository }) => {
		console.log(`[Tool] get_failure_detail：${repository}`)
		const detail = FAILURE_DETAILS[repository]

		return JSON.stringify(
			detail ?? {
				repository,
				found: false,
				message: '没有找到失败测试详情'
			}
		)
	},
	{
		name: 'get_failure_detail',
		description: '查询失败测试的断言、文件位置、实际值与期望值',
		schema: z.object({
			repository: z.string().describe('存在失败测试的代码仓库')
		})
	}
)

function createModel() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	return new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 2,
		modelKwargs: {
			thinking: { type: 'disabled' }
		}
	})
}

let riskAgent

/**
 * 延迟创建 Agent，使 routes 和 mermaid 命令不依赖模型环境变量。
 */
function getRiskAgent() {
	if (riskAgent) {
		return riskAgent
	}

	riskAgent = createAgent({
		model: createModel(),
		tools: [getLatestTestReport, getFailureDetail],
		responseFormat: toolStrategy(RiskAnalysisSchema),
		systemPrompt: `你是研发任务交付风险分析 Agent。

必须先调用 get_latest_test_report 查询测试结果。
如果 failed 大于 0，再调用 get_failure_detail 查询具体失败原因；如果没有失败测试，不要调用失败详情 Tool。
只根据 Tool 返回的数据分析，不得编造测试结果。
存在失败测试时 riskLevel 必须是 high。
最后按照指定结构返回风险结论。`
	})

	return riskAgent
}

/**
 * Node：查询任务。
 */
function loadTask(state) {
	console.log(`[Node:load_task] 查询任务：${state.taskId}`)

	return {
		task: TASKS[state.taskId] ?? null,
		executionPath: 'load_task'
	}
}

/**
 * Conditional Edge：使用明确的业务规则选择下一条流程。
 */
function routeTask(state) {
	if (!state.task) {
		return 'missing'
	}

	if (state.task.status === 'completed') {
		return 'completed'
	}

	return 'needs_analysis'
}

/**
 * Node：处理不存在的任务。
 */
function handleMissingTask(state) {
	console.log('[Node:handle_missing] 任务不存在，跳过 Agent')

	return {
		result: {
			status: 'missing',
			summary: `没有找到任务 ${state.taskId}。`,
			nextAction: '请检查任务编号以后重新提交。'
		},
		executionPath: 'handle_missing'
	}
}

/**
 * Node：处理已经完成的任务。
 */
function handleCompletedTask(state) {
	console.log('[Node:handle_completed] 任务已经完成，跳过 Agent')

	return {
		result: {
			status: 'completed',
			summary: `${state.task.title} 已经完成。`,
			nextAction: '无需继续分析交付风险。'
		},
		executionPath: 'handle_completed'
	}
}

/**
 * Node：把外层 Workflow State 转换成 Agent 输入，再把 Agent 输出写回 State。
 *
 * 外层 Workflow 关心 task、riskAnalysis 和 result；
 * 内层 Agent 则使用 messages、Tool Call 和 ToolMessage 完成自主循环。
 */
async function analyzeDeliveryRisk(state) {
	console.log('[Node:risk_agent] 进入 LangChain Agent')

	// 获取已经配置好的风险分析 Agent。
	// Agent 内部负责模型调用、Tool Calling、Middleware 和结构化结果生成。
	const agent = getRiskAgent()

	/**
	 * 将外层 Workflow State 中的任务信息转换成 Agent 的 messages 输入。
	 *
	 * 从这里开始，控制权进入 Agent：
	 * Agent 会根据任务信息自主判断是否以及按什么顺序调用 Tool，
	 * 并在 Tool 执行结果基础上继续推理，直到生成最终风险分析结果。
	 */
	const agentResult = await agent.invoke({
		messages: [
			{
				role: 'user',
				content: `请分析下面这项研发任务的交付风险：

任务编号：${state.task.taskId}
任务名称：${state.task.title}
负责人：${state.task.owner}
截止日期：${state.task.dueDate}
代码仓库：${state.task.repository}`
			}
		]
	})

	/**
	 * 定义需要记录到外层 Workflow 执行轨迹中的业务 Tool。
	 *
	 * 这里只关心与风险分析直接相关的 Tool，
	 * 避免把其他内部或辅助 Tool 记录到 agentToolPath 中。
	 */
	const businessToolNames = new Set([
		'get_latest_test_report',
		'get_failure_detail'
	])

	/**
	 * 从 Agent 的消息历史中提取实际发生过的业务 Tool Call。
	 *
	 * Agent 执行过程中，AIMessage 的 tool_calls 会记录模型发起的工具调用。
	 * 这里按照消息产生顺序遍历 tool_calls，因此最终得到的数组
	 * 可以反映本次 Agent Run 实际经过的业务 Tool 调用路径。
	 *
	 * 例如：
	 * [
	 *   'get_latest_test_report',
	 *   'get_failure_detail'
	 * ]
	 */
	const agentToolPath = agentResult.messages.flatMap((message) =>
		(message.tool_calls ?? [])
			// 提取每一次 Tool Call 对应的 Tool 名称。
			.map((toolCall) => toolCall.name)

			// 只保留需要暴露给外层 Workflow 的业务 Tool。
			.filter((toolName) => businessToolNames.has(toolName))
	)

	/**
	 * 将 Agent 的执行结果重新转换成外层 Workflow State 所需要的数据。
	 *
	 * LangGraph Node 返回的对象会用于更新当前 State。
	 */
	return {
		// Agent 根据预定义 Structured Output Schema
		// 生成的最终风险分析结果。
		riskAnalysis: agentResult.structuredResponse,

		// 本次 Agent 实际经过的业务 Tool 调用路径。
		agentToolPath,

		// 标记当前分析结果来自 risk_agent 节点，
		// 供后续节点记录或展示整体 Workflow 执行路径。
		executionPath: 'risk_agent'
	}
}

/**
 * Node：使用确定性规则把 Agent 分析结果转换成业务状态。
 */
function finalizeAnalysis(state) {
	console.log('[Node:finalize_analysis] 验收 Agent 分析结果')

	if (!state.riskAnalysis) {
		throw new Error('Agent 没有返回结构化风险分析结果。')
	}

	const blocked = state.riskAnalysis.riskLevel === 'high'

	return {
		result: {
			status: blocked ? 'blocked' : 'review',
			summary: state.riskAnalysis.summary,
			nextAction: blocked
				? '先修复失败测试，再重新发起交付检查。'
				: '风险可控，可以进入人工验收。'
		},
		executionPath: 'finalize_analysis'
	}
}

/**
 * 外层 LangGraph：负责固定流程和业务路由。
 *
 * START → load_task
 *              ├─ missing   → handle_missing   → END
 *              ├─ completed → handle_completed → END
 *              └─ active    → risk_agent → finalize_analysis → END
 */
const deliveryWorkflow = new StateGraph(DeliveryWorkflowState)
	.addNode('load_task', loadTask)
	.addNode('handle_missing', handleMissingTask)
	.addNode('handle_completed', handleCompletedTask)
	.addNode('risk_agent', analyzeDeliveryRisk)
	.addNode('finalize_analysis', finalizeAnalysis)
	.addEdge(START, 'load_task')
	.addConditionalEdges('load_task', routeTask, {
		missing: 'handle_missing',
		completed: 'handle_completed',
		needs_analysis: 'risk_agent'
	})
	.addEdge('handle_missing', END)
	.addEdge('handle_completed', END)
	.addEdge('risk_agent', 'finalize_analysis')
	.addEdge('finalize_analysis', END)
	.compile()

function printResult(result) {
	console.log('外层执行路径：', result.executionPath.join(' -> '))

	if (result.agentToolPath.length > 0) {
		console.log('内层 Agent Tool：', result.agentToolPath.join(' -> '))
	} else {
		console.log('内层 Agent Tool：未进入 Agent')
	}

	console.log('最终业务结果：')
	console.dir(result.result, { depth: null })
}

async function runScenario(taskId) {
	console.log(`\n================ ${taskId} ================`)
	const result = await deliveryWorkflow.invoke({ taskId })
	printResult(result)
}

async function runDemo() {
	await runScenario('DEV-1024')
	await runScenario('DEV-2048')
	await runScenario('DEV-9999')
}

async function runRoutes() {
	await runScenario('DEV-2048')
	await runScenario('DEV-9999')
}

function printMermaid() {
	console.log(deliveryWorkflow.getGraph().drawMermaid())
}

const command = process.argv[2] ?? 'demo'

if (command === 'demo') {
	await runDemo()
} else if (command === 'routes') {
	await runRoutes()
} else if (command === 'mermaid') {
	printMermaid()
} else {
	throw new Error(`未知命令：${command}`)
}

import {
	END,
	START,
	ReducedValue,
	StateGraph,
	StateSchema
} from '@langchain/langgraph'
import * as z from 'zod'

/**
 * 模拟研发任务系统中的数据。
 * 三种任务编号会分别进入正常处理、已完成和缺少资料分支。
 */
const TASKS = {
	'DEV-1024': {
		taskId: 'DEV-1024',
		title: '为任务列表增加 priority 筛选',
		status: 'in_progress',
		owner: '小明',
		dueDate: '2026-08-20'
	},
	'DEV-2048': {
		taskId: 'DEV-2048',
		title: '修复导出文件名称乱码问题',
		status: 'completed',
		owner: '小李',
		dueDate: '2026-08-12'
	}
}

const TaskSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	status: z.enum(['in_progress', 'completed']),
	owner: z.string(),
	dueDate: z.string()
})

const ResultSchema = z.object({
	type: z.enum(['active', 'completed', 'missing']),
	summary: z.string(),
	nextAction: z.string()
})

/**
 * Graph 中所有 Node 共享的 State。
 * 普通字段默认使用最后一次更新；executionPath 使用 Reducer 累积节点轨迹。
 */
const TaskRoutingState = new StateSchema({
	taskId: z.string(),
	task: TaskSchema.nullable().default(null),
	result: ResultSchema.nullable().default(null),
	executionPath: new ReducedValue(
		z.array(z.string()).default(() => []),
		{
			inputSchema: z.string(),
			reducer: (current, nodeName) => [...current, nodeName]
		}
	)
})

/** 读取任务，并把查询结果写回 State。 */
function loadTask(state) {
	const task = TASKS[state.taskId] ?? null

	console.log(`[Node:load_task] 查询任务：${state.taskId}`)

	return {
		task,
		executionPath: 'load_task'
	}
}

/**
 * Conditional Edge 使用的路由函数。
 * 它只读取 State 并返回分支名称，不负责处理具体业务。
 */
function routeTask(state) {
	if (!state.task) {
		return 'missing'
	}

	if (state.task.status === 'completed') {
		return 'completed'
	}

	return 'active'
}

/** 处理仍在进行中的任务。 */
function handleActiveTask(state) {
	console.log('[Node:handle_active] 生成进行中任务的处理建议')

	return {
		result: {
			type: 'active',
			summary: `${state.task.title} 当前由 ${state.task.owner} 负责，任务仍在进行中。`,
			nextAction: `继续推进开发，并在 ${state.task.dueDate} 前完成测试。`
		},
		executionPath: 'handle_active'
	}
}

/** 处理已经完成的任务，避免继续生成开发建议。 */
function handleCompletedTask(state) {
	console.log('[Node:handle_completed] 返回已完成结论')

	return {
		result: {
			type: 'completed',
			summary: `${state.task.title} 已经完成。`,
			nextAction: '不再进入开发流程，可以继续检查发布或验收状态。'
		},
		executionPath: 'handle_completed'
	}
}

/** 处理任务不存在的情况。 */
function handleMissingTask(state) {
	console.log('[Node:handle_missing] 请求补充有效任务编号')

	return {
		result: {
			type: 'missing',
			summary: `没有找到任务 ${state.taskId}。`,
			nextAction: '请检查任务编号，补充有效编号以后再重新执行。'
		},
		executionPath: 'handle_missing'
	}
}

/**
 * 创建并编译任务分流 Graph。
 * 固定 Edge 决定必经步骤，Conditional Edge 根据 State 选择一个分支。
 */
const taskRoutingGraph = new StateGraph(TaskRoutingState)
	.addNode('load_task', loadTask)
	.addNode('handle_active', handleActiveTask)
	.addNode('handle_completed', handleCompletedTask)
	.addNode('handle_missing', handleMissingTask)
	.addEdge(START, 'load_task')
	.addConditionalEdges('load_task', routeTask, {
		active: 'handle_active',
		completed: 'handle_completed',
		missing: 'handle_missing'
	})
	.addEdge('handle_active', END)
	.addEdge('handle_completed', END)
	.addEdge('handle_missing', END)
	.compile()

/** 运行单个任务，并打印最终 State。 */
async function runScenario(taskId) {
	console.log(`\n================ ${taskId} ================`)

	const result = await taskRoutingGraph.invoke({ taskId })

	console.log('执行路径：', result.executionPath.join(' -> '))
	console.log('处理结果：', result.result)
}

/** 依次验证三条分支。 */
async function runDemo() {
	await runScenario('DEV-1024')
	await runScenario('DEV-2048')
	await runScenario('DEV-9999')
}

/** 使用 updates 模式观察每个 Node 返回的 State 更新。 */
async function runStreamDemo() {
	console.log('\n========== Stream：DEV-1024 ==========')

	const stream = await taskRoutingGraph.stream(
		{ taskId: 'DEV-1024' },
		{ streamMode: 'updates' }
	)

	for await (const update of stream) {
		console.dir(update, { depth: null })
	}
}

/** 输出可以粘贴到 Mermaid 编辑器中的图结构。 */
function printMermaid() {
	console.log(taskRoutingGraph.getGraph().drawMermaid())
}

const mode = process.argv[2] ?? 'demo'

if (mode === 'stream') {
	await runStreamDemo()
} else if (mode === 'mermaid') {
	printMermaid()
} else {
	await runDemo()
}

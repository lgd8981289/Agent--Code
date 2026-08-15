import {
	END,
	START,
	ReducedValue,
	StateGraph,
	StateSchema
} from '@langchain/langgraph'
import * as z from 'zod'

/**
 * 模拟研发任务系统中的任务数据。
 *
 * 不同任务会触发不同的 Graph 分支：
 * - DEV-1024：任务进行中，进入 active 分支
 * - DEV-2048：任务已完成，进入 completed 分支
 * - 其他不存在的任务编号：进入 missing 分支
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

/**
 * 单个任务的数据结构。
 *
 * 后续会作为 Graph State 中 task 字段的类型约束。
 */
const TaskSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	status: z.enum(['in_progress', 'completed']),
	owner: z.string(),
	dueDate: z.string()
})

/**
 * Graph 最终处理结果的数据结构。
 *
 * type 用来表示任务最终进入了哪一种业务分支。
 */
const ResultSchema = z.object({
	type: z.enum(['active', 'completed', 'missing']),
	summary: z.string(),
	nextAction: z.string()
})

/**
 * 定义整个 StateGraph 运行期间共享的 State。
 *
 * 可以把 State 理解为：
 *
 *    Graph 中所有 Node 共同读写的一份运行时数据。
 *
 * Node 不需要直接调用其他 Node，
 * 而是通过读取 State、返回 State 更新来完成数据传递。
 */
const TaskRoutingState = new StateSchema({
	/**
	 * 当前需要查询的任务编号。
	 *
	 * invoke() 启动 Graph 时由外部传入。
	 */
	taskId: z.string(),

	/**
	 * 查询得到的任务信息。
	 *
	 * 初始值为 null，
	 * load_task Node 执行后会更新这个字段。
	 */
	task: TaskSchema.nullable().default(null),

	/**
	 * Graph 最终生成的业务处理结果。
	 *
	 * 初始值为 null，
	 * 后续不同分支 Node 会写入对应结果。
	 */
	result: ResultSchema.nullable().default(null),

	/**
	 * 记录 Graph 实际经过的 Node。
	 *
	 * ReducedValue 与普通 State 字段不同：
	 *
	 * 普通字段：
	 *    后一次更新通常覆盖前一次更新。
	 *
	 * ReducedValue：
	 *    每次 Node 返回新值时，会通过 reducer
	 *    将新值与旧值合并。
	 *
	 * 因此 executionPath 可以不断累积：
	 *
	 *    ['load_task']
	 *        ↓
	 *    ['load_task', 'handle_active']
	 */
	executionPath: new ReducedValue(
		z.array(z.string()).default(() => []),
		{
			/**
			 * 每个 Node 更新 executionPath 时，
			 * 只需要返回当前 Node 名称即可。
			 */
			inputSchema: z.string(),

			/**
			 * Reducer 决定：
			 * 当前 State 中已有的值和本次新值如何合并。
			 */
			reducer: (current, nodeName) => [...current, nodeName]
		}
	)
})

/**
 * Node：读取任务信息。
 *
 * Node 的基本职责通常是：
 *
 *    State
 *      ↓
 *    执行业务逻辑
 *      ↓
 *    返回需要更新的部分 State
 *
 * LangGraph 会把这里返回的数据自动合并回 Graph State。
 */
function loadTask(state) {
	const task = TASKS[state.taskId] ?? null

	console.log(`[Node:load_task] 查询任务：${state.taskId}`)

	return {
		// 更新 task 字段
		task,

		// executionPath 是 ReducedValue，
		// 因此这里返回字符串即可，由 reducer 负责追加。
		executionPath: 'load_task'
	}
}

/**
 * Conditional Edge 使用的路由函数。
 *
 * 它本身不是一个业务处理 Node，
 * 主要负责根据当前 State 判断下一步应该走哪个分支。
 *
 * 返回值会与 addConditionalEdges() 中定义的映射关系对应。
 */
function routeTask(state) {
	// 没查到任务
	if (!state.task) {
		return 'missing'
	}

	// 已完成任务
	if (state.task.status === 'completed') {
		return 'completed'
	}

	// 其他情况进入进行中任务分支
	return 'active'
}

/**
 * Node：处理仍在进行中的任务。
 *
 * 当前分支只会在：
 *
 *    routeTask() === 'active'
 *
 * 时执行。
 */
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

/**
 * Node：处理已经完成的任务。
 *
 * 已完成任务不应该继续生成开发建议，
 * 因此单独进入 completed 分支。
 */
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

/**
 * Node：处理任务不存在的情况。
 *
 * 当 load_task 没有查询到任务时，
 * Conditional Edge 会把执行流程路由到这里。
 */
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
 * 创建任务分流 StateGraph。
 *
 * Graph 的整体结构：
 *
 *                  ┌→ handle_active ───────→ END
 *                  │
 * START → load_task ├→ handle_completed ───→ END
 *                  │
 *                  └→ handle_missing ──────→ END
 *
 * 其中：
 *
 * - Node：真正执行处理逻辑
 * - Edge：决定固定的执行顺序
 * - Conditional Edge：根据 State 动态决定下一步
 */
const taskRoutingGraph = new StateGraph(TaskRoutingState)

	/**
	 * 注册 Graph 中的 Node。
	 *
	 * 第一个参数是 Node 名称，
	 * 第二个参数是 Node 实际执行的函数。
	 */
	.addNode('load_task', loadTask)
	.addNode('handle_active', handleActiveTask)
	.addNode('handle_completed', handleCompletedTask)
	.addNode('handle_missing', handleMissingTask)

	/**
	 * 固定 Edge：
	 *
	 * Graph 启动以后，首先进入 load_task。
	 *
	 * START 是 LangGraph 提供的特殊起点节点。
	 */
	.addEdge(START, 'load_task')

	/**
	 * Conditional Edge：
	 *
	 * load_task 执行完成后，
	 * 调用 routeTask(state) 判断下一步应该进入哪个 Node。
	 *
	 * routeTask 返回：
	 *
	 * active
	 * completed
	 * missing
	 *
	 * 再通过下面的映射找到真正需要执行的 Node。
	 */
	.addConditionalEdges('load_task', routeTask, {
		active: 'handle_active',
		completed: 'handle_completed',
		missing: 'handle_missing'
	})

	/**
	 * 三个业务分支处理完成后都结束 Graph。
	 *
	 * END 是 LangGraph 提供的特殊终点节点。
	 */
	.addEdge('handle_active', END)
	.addEdge('handle_completed', END)
	.addEdge('handle_missing', END)

	/**
	 * compile() 把前面声明的 State、Node 和 Edge
	 * 编译成真正可以 invoke()/stream() 的可执行 Graph。
	 */
	.compile()

/**
 * 执行一个完整的 Graph 场景。
 */
async function runScenario(taskId) {
	console.log(`\n================ ${taskId} ================`)

	/**
	 * invoke() 启动一次完整 Graph Run。
	 *
	 * 初始 State：
	 *
	 * {
	 *   taskId
	 * }
	 *
	 * LangGraph 会按照 Edge 和 Conditional Edge
	 * 自动执行后续 Node，直到到达 END。
	 *
	 * result 是 Graph 执行结束后的最终 State。
	 */
	const result = await taskRoutingGraph.invoke({ taskId })

	console.log('执行路径：', result.executionPath.join(' -> '))
	console.log('处理结果：', result.result)
}

/**
 * 依次执行三个任务，
 * 用于验证 Conditional Edge 的三条分支。
 */
async function runDemo() {
	// active 分支
	await runScenario('DEV-1024')

	// completed 分支
	await runScenario('DEV-2048')

	// missing 分支
	await runScenario('DEV-9999')
}

/**
 * 使用 stream() 观察 Graph 的执行过程。
 *
 * invoke() 更关注：
 *
 *    Graph 最终执行结果
 *
 * stream() 更关注：
 *
 *    Graph 执行过程中每一步发生了什么
 */
async function runStreamDemo() {
	console.log('\n========== Stream：DEV-1024 ==========')

	/**
	 * streamMode: 'updates'
	 *
	 * 表示每次 Node 执行完成后，
	 * 返回这个 Node 对 State 产生的增量更新。
	 *
	 * 而不是每次都返回完整 State。
	 */
	const stream = await taskRoutingGraph.stream(
		{ taskId: 'DEV-1024' },
		{ streamMode: 'updates' }
	)

	/**
	 * Graph Stream 是异步迭代器，
	 * 因此使用 for await...of 持续读取 Node 更新。
	 */
	for await (const update of stream) {
		console.dir(update, { depth: null })
	}
}

/**
 * 输出当前 Graph 的 Mermaid 描述。
 *
 * 可以复制输出内容到 Mermaid 编辑器中，
 * 直接查看 Graph 的节点和 Edge 结构。
 */
function printMermaid() {
	console.log(taskRoutingGraph.getGraph().drawMermaid())
}

/**
 * 根据命令行参数决定演示模式。
 *
 * npm/node 启动时例如：
 *
 * node demo.js
 * node demo.js stream
 * node demo.js mermaid
 */
const mode = process.argv[2] ?? 'demo'

if (mode === 'stream') {
	// 查看 Graph 每一步 State 更新
	await runStreamDemo()
} else if (mode === 'mermaid') {
	// 输出 Graph 的 Mermaid 结构
	printMermaid()
} else {
	// 默认执行三种任务分支
	await runDemo()
}

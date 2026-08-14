import { ChatDeepSeek } from '@langchain/deepseek'
import {
	createAgent,
	createMiddleware,
	modelCallLimitMiddleware,
	tool,
	toolCallLimitMiddleware,
	toolRetryMiddleware,
	toolStrategy
} from 'langchain'
import * as z from 'zod'

const PRINCIPALS = {
	'developer-session': {
		userId: 'U1001',
		tenantId: 'blue-whale',
		tenantName: '蓝鲸科技',
		roles: ['developer']
	},
	'maintainer-session': {
		userId: 'U1002',
		tenantId: 'blue-whale',
		tenantName: '蓝鲸科技',
		roles: ['developer', 'maintainer']
	}
}

const TASKS = {
	'blue-whale': {
		'DEV-1024': {
			taskId: 'DEV-1024',
			title: '为任务列表增加 priority 筛选',
			status: 'in_progress',
			owner: '小明',
			dueDate: '2026-08-15',
			repository: 'task-service'
		}
	}
}

const TEST_REPORTS = {
	'blue-whale': {
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
}

const FAILURE_DETAILS = {
	'blue-whale': {
		'task-service': {
			errorType: 'AssertionError',
			location: 'src/tasks/task.service.spec.ts:84',
			actual: 'medium',
			expected: 'high'
		}
	}
}

const reportAttempts = new Map()

function authenticate(sessionId) {
	const principal = PRINCIPALS[sessionId]

	if (!principal) {
		throw new Error('当前会话没有通过身份认证。')
	}

	return principal
}

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

/**
 * 每次 Agent Run 的可信运行信息。
 *
 * simulateMalformedReport 只用于演示上游系统第一次返回残缺数据，
 * 真实项目中可以替换成数据库、HTTP 服务或测试平台的实际异常。
 */
const contextSchema = z.object({
	userId: z.string(),
	tenantId: z.string(),
	tenantName: z.string(),
	roles: z.array(z.string()),
	runId: z.string(),
	simulateMalformedReport: z.boolean()
})

const getTask = tool(
	async ({ taskId }, runtime) => {
		const { tenantId } = runtime.context
		const task = TASKS[tenantId]?.[taskId]

		console.log(`[Tool] get_task 查询任务：${taskId}`)

		return JSON.stringify(
			task
				? { found: true, ...task }
				: { found: false, taskId, message: '当前租户下没有找到对应任务' }
		)
	},
	{
		name: 'get_task',
		description: '查询当前租户中的研发任务，并返回任务对应的代码仓库',
		schema: z.object({
			taskId: z.string().describe('研发任务编号，例如 DEV-1024')
		})
	}
)

const getLatestTestReport = tool(
	async ({ repository }, runtime) => {
		const { tenantId, runId, simulateMalformedReport } = runtime.context
		const attemptKey = `${runId}:${repository}`
		const attempt = (reportAttempts.get(attemptKey) ?? 0) + 1
		reportAttempts.set(attemptKey, attempt)

		console.log(`[Tool] get_latest_test_report 第 ${attempt} 次执行`)

		if (simulateMalformedReport && attempt === 1) {
			return JSON.stringify({
				found: true,
				repository
			})
		}

		const report = TEST_REPORTS[tenantId]?.[repository]

		return JSON.stringify(
			report
				? { found: true, ...report }
				: {
						found: false,
						repository,
						message: '当前租户下没有找到测试报告'
					}
		)
	},
	{
		name: 'get_latest_test_report',
		description: '查询当前租户中指定代码仓库的最新自动化测试报告',
		schema: z.object({
			repository: z.string().describe('get_task 返回的代码仓库名称')
		})
	}
)

/**
 * 失败详情包含内部测试文件位置，只允许 maintainer 角色使用。
 */
const getFailureDetail = tool(
	async ({ repository }, runtime) => {
		const { tenantId } = runtime.context

		console.log(`[Tool] get_failure_detail 查询失败详情：${repository}`)

		const detail = FAILURE_DETAILS[tenantId]?.[repository]
		return JSON.stringify(
			detail
				? { found: true, repository, ...detail }
				: { found: false, repository, message: '没有找到失败详情' }
		)
	},
	{
		name: 'get_failure_detail',
		description: '查询失败测试的内部断言、代码位置与实际值，仅维护者可以使用',
		schema: z.object({
			repository: z.string().describe('测试失败的代码仓库名称')
		})
	}
)

/**
 * 当前风险分析 Agent 注册的完整 Tool 集合。
 *
 * - getTask：根据任务 ID 查询研发任务基础信息
 * - getLatestTestReport：根据任务所属仓库查询最新测试报告
 * - getFailureDetail：在测试失败时进一步查询具体失败详情
 *
 * 后续 permissionMiddleware 会根据当前用户角色，
 * 从 ALL_TOOLS 中过滤出本次模型实际可见、可调用的 Tool。
 */
const ALL_TOOLS = [getTask, getLatestTestReport, getFailureDetail]

/**
 * Tool 与角色之间的权限映射关系。
 *
 * Key 表示 Tool 名称，
 * Value 表示允许使用该 Tool 的角色列表。
 *
 * 当前权限规则：
 * - developer：可以查询任务和最新测试报告
 * - maintainer：除了上述能力外，还可以进一步查询失败详情
 *
 * permissionMiddleware 会通过这份配置判断：
 * 1. 某个 Tool 是否应该对当前模型可见
 * 2. 某个 Tool 在真正执行前是否具有调用权限
 */
const TOOL_ROLES = {
	// developer 和 maintainer 都可以查询研发任务基础信息。
	get_task: ['developer', 'maintainer'],

	// developer 和 maintainer 都可以查询仓库最新测试报告。
	get_latest_test_report: ['developer', 'maintainer'],

	// 失败详情属于权限更高的能力，只允许 maintainer 使用。
	get_failure_detail: ['maintainer']
}

function canUseTool(roles, toolName) {
	const allowedRoles = TOOL_ROLES[toolName] ?? []
	return roles.some((role) => allowedRoles.includes(role))
}

/**
 * 权限边界包含两层：
 * 1. 调用模型前，只暴露当前角色可以使用的 Tool；
 * 2. Tool 真正执行前，再校验一次权限。
 */
/**
 * Tool 权限控制 Middleware。
 *
 * 主要负责两层权限控制：
 *
 * 1. 在调用模型之前，根据当前用户角色过滤模型可以看到的 Tool。
 * 2. 在真正执行 Tool 之前，再次校验当前角色是否拥有执行权限。
 *
 * 第一层属于“能力可见性控制”，
 * 第二层属于“执行权限兜底校验”。
 */
const permissionMiddleware = createMiddleware({
	name: 'PermissionMiddleware',

	// 定义当前 Middleware 依赖的 Runtime Context 数据结构。
	// 这里会从 Context 中读取当前用户的 roles 等权限信息。
	contextSchema,

	/**
	 * 包装模型调用过程。
	 *
	 * 在请求真正发送给模型之前，
	 * 根据当前用户角色过滤本次模型可以看到的 Tool。
	 */
	wrapModelCall: (request, handler) => {
		// 从 Agent Runtime Context 中读取当前用户的角色。
		const { roles } = request.runtime.context

		/**
		 * 从当前已经注册的 Tool 中，
		 * 筛选出当前角色有权限使用的 Tool。
		 *
		 * canUseTool() 负责真正的权限判断逻辑。
		 */
		const allowedTools = request.tools.filter((currentTool) =>
			canUseTool(roles, currentTool.name)
		)

		// 输出本轮模型实际能够看到的 Tool，方便调试权限控制结果。
		console.log(
			`[Middleware:Permission] 模型可见 Tool：${allowedTools
				.map((currentTool) => currentTool.name)
				.join(', ')}`
		)

		/**
		 * 继续执行后续 Middleware / Model Call。
		 *
		 * 这里不会把原始 request.tools 直接传给模型，
		 * 而是替换成经过权限过滤后的 allowedTools。
		 *
		 * 因此模型只能感知并调用当前角色有权限使用的 Tool。
		 */
		return handler({
			...request,
			tools: allowedTools
		})
	},

	/**
	 * 包装 Tool 的实际执行过程。
	 *
	 * 即使模型已经通过 wrapModelCall 只能看到授权 Tool，
	 * 在 Tool 真正执行之前仍然再做一次权限校验，
	 * 避免绕过模型可见性控制直接触发未授权 Tool。
	 */
	wrapToolCall: (request, handler) => {
		// 获取当前用户角色。
		const { roles } = request.runtime.context

		// 获取模型本次准备调用的 Tool 名称。
		const toolName = request.toolCall.name

		/**
		 * 再次检查当前角色是否有权执行该 Tool。
		 *
		 * 如果没有权限，则直接阻止 Tool 调用，
		 * 不会继续进入真正的 Tool Handler。
		 */
		if (!canUseTool(roles, toolName)) {
			throw new Error(`当前角色无权执行 Tool：${toolName}`)
		}

		console.log(`[Middleware:Permission] 允许执行：${toolName}`)

		// 权限校验通过，继续执行真正的 Tool。
		return handler(request)
	}
})

class InvalidToolResultError extends Error {
	constructor(message) {
		super(message)
		this.name = 'InvalidToolResultError'
	}
}

function isInvalidToolResult(error) {
	let currentError = error

	while (currentError instanceof Error) {
		if (currentError instanceof InvalidToolResultError) {
			return true
		}

		currentError = currentError.cause
	}

	return false
}

const TestReportResult = z.discriminatedUnion('found', [
	z.object({
		found: z.literal(true),
		repository: z.string(),
		passed: z.number(),
		failed: z.number(),
		failures: z.array(z.string())
	}),
	z.object({
		found: z.literal(false),
		repository: z.string(),
		message: z.string()
	})
])

function toolMessageText(toolMessage) {
	if (typeof toolMessage.content === 'string') {
		return toolMessage.content
	}

	return JSON.stringify(toolMessage.content)
}

/**
 * Tool 结果校验 Middleware。
 *
 * 当前只对 get_latest_test_report 的返回结果进行严格校验。
 *
 * 主要流程：
 * 1. 先执行真正的 Tool。
 * 2. 如果不是 get_latest_test_report，直接返回结果。
 * 3. 如果是测试报告 Tool，则解析 ToolMessage 中的 JSON。
 * 4. 使用 TestReportResult Schema 校验结果结构。
 * 5. 校验失败时抛出 InvalidToolResultError，
 *    让外层的 Retry Middleware 决定是否重新执行 Tool。
 *
 * 只有通过校验的测试报告，才允许继续进入后续 Agent 流程。
 */
const resultValidationMiddleware = createMiddleware({
	name: 'ResultValidationMiddleware',

	// 定义当前 Middleware 依赖的 Runtime Context 数据结构。
	contextSchema,

	/**
	 * 包装 Tool 调用过程，对 Tool 返回结果进行校验。
	 */
	wrapToolCall: async (request, handler) => {
		/**
		 * 先执行真正的 Tool。
		 *
		 * result 通常是 Tool 执行完成后生成的 ToolMessage。
		 */
		const result = await handler(request)

		/**
		 * 当前 Middleware 只校验 get_latest_test_report。
		 *
		 * 其他 Tool 的返回结果不经过这里的 TestReportResult 校验，
		 * 直接返回给 Agent Runtime。
		 */
		if (request.toolCall.name !== 'get_latest_test_report') {
			return result
		}

		let data

		/**
		 * 从 ToolMessage 中提取文本内容，并解析成 JSON。
		 *
		 * 如果 Tool 返回的内容连合法 JSON 都不是，
		 * 说明这次结果无法作为可信 Observation 使用。
		 */
		try {
			data = JSON.parse(toolMessageText(result))
		} catch {
			throw new InvalidToolResultError('测试报告不是合法 JSON。')
		}

		/**
		 * 使用 Zod Schema 校验测试报告的数据结构。
		 *
		 * TestReportResult.safeParse() 不会直接抛出异常，
		 * 而是通过 success 表示校验是否成功。
		 */
		const validation = TestReportResult.safeParse(data)

		/**
		 * 如果缺少关键字段，则认为这次 Tool 调用结果无效。
		 *
		 * 例如测试报告必须包含：
		 * - passed
		 * - failed
		 * - failures
		 *
		 * 此时抛出 InvalidToolResultError，
		 * 外层 toolRetryMiddleware 可以识别该错误并重新执行 Tool。
		 */
		if (!validation.success) {
			console.log('[Middleware:Validation] 测试报告字段不完整，拒绝写入 State')

			throw new InvalidToolResultError(
				'测试报告缺少 passed、failed 或 failures。'
			)
		}

		// 结果结构完整，可以作为有效 Tool Observation 继续使用。
		console.log('[Middleware:Validation] 测试报告通过校验')

		return result
	}
})

const RiskAnalysis = z.object({
	taskId: z.string(),
	riskLevel: z.enum(['low', 'medium', 'high']),
	summary: z.string(),
	evidence: z.array(z.string()).min(2),
	suggestions: z.array(z.string()).min(1)
})

/**
 * 创建研发任务交付风险分析 Agent。
 *
 * @param {object} options Agent 运行限制配置
 * @param {number} options.modelRunLimit 单次 Agent Run 最多允许调用模型的次数
 * @param {number} options.toolRunLimit 单次 Agent Run 最多允许调用 Tool 的次数
 */
function createRiskAgent({ modelRunLimit = 5, toolRunLimit = 4 } = {}) {
	return createAgent({
		// 创建当前 Agent 使用的 LLM。
		model: createModel(),

		// 注册 Agent 可以调用的全部 Tool。
		// 实际运行过程中，Middleware 还可以根据权限进一步控制 Tool 的可见性。
		tools: ALL_TOOLS,

		// 定义 Runtime Context 的结构，
		// 例如当前用户、租户、角色等运行时上下文信息。
		contextSchema,

		// 要求 Agent 最终按照 RiskAnalysis Schema 返回结构化结果。
		responseFormat: toolStrategy(RiskAnalysis),

		// 定义 Agent 的任务目标以及 Tool 调用约束。
		systemPrompt: `你是研发任务交付风险分析 Agent。


必须先调用 get_task，再使用返回的 repository 调用 get_latest_test_report。
如果测试失败，并且当前可用 Tool 中存在 get_failure_detail，则继续查询失败详情。
只能使用当前可见的 Tool，不得声称自己调用了不存在的能力。
最后根据已经通过校验的 Tool 结果，返回结构化风险结论。`,

		middleware: [
			/**
			 * 根据当前 Runtime Context 对 Tool 权限进行过滤或控制。
			 *
			 * 例如不同用户、角色或租户可能只能看到部分 Tool，
			 * Agent 只能调用当前实际可见的能力。
			 */
			permissionMiddleware,

			/**
			 * 限制单次 Agent Run 中模型调用次数。
			 *
			 * 超过 modelRunLimit 后直接抛出错误，
			 * 防止 Agent 因反复推理而无限消耗模型调用次数。
			 */
			modelCallLimitMiddleware({
				runLimit: modelRunLimit,
				exitBehavior: 'error'
			}),

			/**
			 * 限制单次 Agent Run 中 Tool 调用次数。
			 *
			 * 超过 toolRunLimit 后直接终止，
			 * 防止 Agent 出现工具调用死循环或无效重复调用。
			 */
			toolCallLimitMiddleware({
				runLimit: toolRunLimit,
				exitBehavior: 'error'
			}),

			/**
			 * 为指定 Tool 增加失败重试能力。
			 *
			 * Retry 必须包在 Validation 外层。
			 * Validation 抛出的可重试错误，才能回到 Retry 再执行一次 Tool。
			 */
			toolRetryMiddleware({
				// 这里只对测试报告查询 Tool 启用重试。
				tools: ['get_latest_test_report'],

				// 首次调用失败后最多额外重试 1 次。
				maxRetries: 1,

				// 当前示例为了方便演示，不等待直接重试。
				initialDelayMs: 0,

				// 不使用指数退避。
				backoffFactor: 0,

				// 不增加随机抖动时间。
				jitter: false,

				/**
				 * 判断当前异常是否属于可以重试的 Tool 结果校验错误。
				 *
				 * 多层 Middleware 会使用 MiddlewareError 包装内部异常，
				 * 因此 isInvalidToolResult 需要沿着 cause 找到最初的结果校验错误。
				 */
				retryOn: isInvalidToolResult,

				// 重试仍然失败时，将错误继续向外抛出。
				onFailure: 'error'
			}),

			/**
			 * 对 Tool 返回的结果进行统一校验。
			 *
			 * 如果返回结果缺少关键字段、格式不正确或不满足业务要求，
			 * Middleware 会抛出校验异常。
			 *
			 * 当异常属于可重试错误时，
			 * 外层的 toolRetryMiddleware 会重新执行对应 Tool。
			 */
			resultValidationMiddleware
		]
	})
}

async function analyzeDeliveryRisk({
	sessionId,
	question,
	simulateMalformedReport = false,
	limits
}) {
	const principal = authenticate(sessionId)
	const runId = crypto.randomUUID()
	const agent = createRiskAgent(limits)

	return agent.invoke(
		{
			messages: [{ role: 'user', content: question }]
		},
		{
			context: {
				...principal,
				runId,
				simulateMalformedReport
			}
		}
	)
}

function printResult(result) {
	console.log('\nstructuredResponse：')
	console.dir(result.structuredResponse, { depth: null })
}

async function runPermissionDemo() {
	console.log('\n================ 权限：developer ================')
	const developerResult = await analyzeDeliveryRisk({
		sessionId: 'developer-session',
		question: '分析 DEV-1024 的交付风险，并尽可能查询失败测试详情。'
	})
	printResult(developerResult)

	console.log('\n================ 权限：maintainer ================')
	const maintainerResult = await analyzeDeliveryRisk({
		sessionId: 'maintainer-session',
		question: '分析 DEV-1024 的交付风险，并查询失败测试详情。'
	})
	printResult(maintainerResult)
}

async function runRetryDemo() {
	console.log('\n================ 结果校验与自动重试 ================')
	const result = await analyzeDeliveryRisk({
		sessionId: 'maintainer-session',
		question: '分析 DEV-1024 的交付风险，并查询失败测试详情。',
		simulateMalformedReport: true
	})
	printResult(result)
}

async function runBudgetDemo() {
	console.log('\n================ 模型调用预算 ================')

	try {
		await analyzeDeliveryRisk({
			sessionId: 'maintainer-session',
			question: '分析 DEV-1024 的交付风险。',
			limits: {
				modelRunLimit: 1,
				toolRunLimit: 4
			}
		})
	} catch (error) {
		console.log('第二次模型调用以前，Agent 已停止：')
		console.log(error.message)
	}

	console.log('\n================ Tool 调用预算 ================')

	try {
		await analyzeDeliveryRisk({
			sessionId: 'maintainer-session',
			question: '分析 DEV-1024 的交付风险。',
			limits: {
				modelRunLimit: 5,
				toolRunLimit: 1
			}
		})
	} catch (error) {
		console.log('第二次 Tool 调用以前，Agent 已停止：')
		console.log(error.message)
	}
}

const command = process.argv[2] ?? 'demo'

if (command === 'permission') {
	await runPermissionDemo()
} else if (command === 'retry') {
	await runRetryDemo()
} else if (command === 'budget') {
	await runBudgetDemo()
} else if (command === 'demo') {
	await runPermissionDemo()
	await runRetryDemo()
	await runBudgetDemo()
} else {
	throw new Error(`未知命令：${command}`)
}

import type { ScenarioDefinition } from './agent.types'

/**
 * “任务优先级筛选”实验场景。
 *
 * 用于验证 Agent 是否能够先分析现有任务模块，
 * 再为 GET /tasks 补充 priority 查询参数，并完成测试与类型检查。
 */
const priorityFilter: ScenarioDefinition = {
	// 场景唯一标识，用于创建 Agent Run 和加载对应工作区。
	id: 'priority-filter',

	// 前端场景列表中展示的名称和简介。
	title: '实现任务优先级筛选',
	shortDescription:
		'分析现有 NestJS 任务模块，补齐 priority 查询参数并通过测试。',

	// Agent 本次需要完成的自然语言需求。
	requirement:
		'为 GET /tasks 增加 priority 筛选能力，支持 low、medium、high，并保持已有 status 筛选兼容。',

	// 场景类型与需要叠加到基础项目中的实验代码层。
	category: 'feature',
	overlay: 'priority-filter',

	// 判断任务是否真正完成的验收标准。
	completionCriteria: [
		'TaskFilters 支持 priority 字段',
		'TaskService 可以同时按 status 和 priority 筛选',
		'TaskController 接收 priority 查询参数',
		'全部测试和类型检查通过'
	],

	// 初始任务计划，通过 dependsOn 描述步骤之间的执行依赖。
	initialSteps: [
		{
			id: 'reproduce-and-inspect',
			title: '复现失败并分析任务模块',
			description: '运行测试，读取 Service、Controller 和类型定义。',
			dependsOn: []
		},
		{
			id: 'implement-filter',
			title: '实现 priority 筛选',
			description: '修改类型、业务逻辑和接口参数。',
			dependsOn: ['reproduce-and-inspect']
		},
		{
			id: 'verify-change',
			title: '验证代码改动',
			description: '运行测试、类型检查并检查最终 Diff。',
			dependsOn: ['implement-filter']
		}
	],

	// 限制 Agent 可以修改或删除的文件，并补充本场景的执行约束。
	workspacePolicy: {
		writablePaths: [
			'src/tasks/task.types.ts',
			'src/tasks/task.service.ts',
			'src/tasks/task.controller.ts'
		],

		// 当前任务不允许删除任何文件。
		deletablePaths: [],

		instructions: [
			'只实现 priority 查询筛选，不增加依赖或修改测试文件。',
			'保留已有 status 筛选行为，并允许两个筛选条件同时生效。',
			'修改前必须读取相关类型、Service 与 Controller。'
		]
	},

	/**
	 * Replay 模式使用的固定决策轨迹。
	 *
	 * 每个 Action 描述要调用的工具、参数、所属计划步骤和执行原因；
	 * completesStepIds 用于标记完成该 Action 后可以结束哪些计划步骤。
	 */
	playbook: [
		// 先运行测试，确认当前项目尚未满足 priority 筛选需求。
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'reproduce-and-inspect',
			reasoning: '先运行现有测试，确认新需求当前确实没有实现。'
		},

		// 读取类型定义，确认 TaskFilters 和 TaskPriority 的现有结构。
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/task.types.ts' },
			stepId: 'reproduce-and-inspect',
			reasoning: '先确认筛选参数和优先级类型的现有定义。'
		},

		// 读取 Service，分析当前 status 筛选逻辑。
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/task.service.ts' },
			stepId: 'reproduce-and-inspect',
			reasoning: '检查任务列表当前如何应用 status 条件。'
		},

		// 读取 Controller，确认查询参数如何传递给 Service。
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/task.controller.ts' },
			stepId: 'reproduce-and-inspect',
			reasoning: '确认 Controller 当前接收哪些查询参数。',
			completesStepIds: ['reproduce-and-inspect']
		},

		// 扩展 TaskFilters，使其能够接收 priority 筛选条件。
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/task.types.ts',
				replacements: [
					{
						search: 'export interface TaskFilters {\n\tstatus?: TaskStatus\n}',
						replacement:
							'export interface TaskFilters {\n\tstatus?: TaskStatus\n\tpriority?: TaskPriority\n}'
					}
				]
			},
			stepId: 'implement-filter',
			reasoning: '先让筛选参数类型支持 priority。'
		},

		// 在 Service 中同时应用 status 和 priority 两个筛选条件。
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/task.service.ts',
				replacements: [
					{
						search:
							'\t\treturn this.tasks.filter((task) => {\n\t\t\treturn !filters.status || task.status === filters.status\n\t\t})',
						replacement:
							'\t\treturn this.tasks.filter((task) => {\n\t\t\tconst matchesStatus =\n\t\t\t\t!filters.status || task.status === filters.status\n\t\t\tconst matchesPriority =\n\t\t\t\t!filters.priority || task.priority === filters.priority\n\n\t\t\treturn matchesStatus && matchesPriority\n\t\t})'
					}
				]
			},
			stepId: 'implement-filter',
			reasoning: '把 status 和 priority 两个条件组合进列表过滤逻辑。'
		},

		// 让 Controller 接收 priority 查询参数，并传递给 TaskService。
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/task.controller.ts',
				replacements: [
					{
						search: "import type { TaskStatus } from './task.types'",
						replacement:
							"import type { TaskPriority, TaskStatus } from './task.types'"
					},
					{
						search:
							"\tlist(@Query('status') status?: TaskStatus) {\n\t\treturn this.taskService.list({ status })\n\t}",
						replacement:
							"\tlist(\n\t\t@Query('status') status?: TaskStatus,\n\t\t@Query('priority') priority?: TaskPriority\n\t) {\n\t\treturn this.taskService.list({ status, priority })\n\t}"
					}
				]
			},
			stepId: 'implement-filter',
			reasoning: '让 HTTP 接口把 priority 传给 TaskService。',
			completesStepIds: ['implement-filter']
		},

		// 运行完整测试，确认新增筛选逻辑没有破坏已有行为。
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'verify-change',
			reasoning: '运行完整测试，确认筛选功能和已有行为都正确。'
		},

		// 执行类型检查，验证 Controller、Service 与类型定义保持一致。
		{
			type: 'action',
			toolName: 'run_typecheck',
			arguments: {},
			stepId: 'verify-change',
			reasoning: '继续检查 Controller、Service 与类型定义是否一致。'
		},

		// 查看最终 Diff，确认修改范围符合工作区策略和任务要求。
		{
			type: 'action',
			toolName: 'get_git_diff',
			arguments: {},
			stepId: 'verify-change',
			reasoning: '检查最终修改范围是否只覆盖当前需求。',
			completesStepIds: ['verify-change']
		},

		// 所有计划步骤完成后，输出本次运行的最终结论。
		{
			type: 'final',
			summary: 'priority 筛选已完成，原有 status 筛选保持兼容。'
		}
	],

	// Runtime 最终验收时使用的预期修改范围和验证要求。
	expected: {
		changedPaths: [
			'src/tasks/task.types.ts',
			'src/tasks/task.service.ts',
			'src/tasks/task.controller.ts'
		],
		requireTests: true,
		requireTypecheck: true
	}
}

/**
 * “逾期时间边界修复”实验场景。
 *
 * 用于验证 Agent 是否能够先通过失败测试获得证据，
 * 再根据 Observation 更新任务计划，最后修复日期比较边界问题。
 */
const overdueBoundary: ScenarioDefinition = {
	// 场景唯一标识，用于创建 Run 和加载对应的工作区覆盖层。
	id: 'overdue-boundary',

	// 前端场景列表中展示的标题和简介。
	title: '修复逾期时间边界错误',
	shortDescription: '用失败测试推翻初始假设，更新计划后修复时间边界。',

	// Agent 需要完成的原始任务需求。
	requirement:
		'任务列表中偶尔会出现错误的逾期标记。值班同学怀疑完成状态过滤有问题，请定位真正原因并修复，同时保证完成任务永远不算逾期。',

	// 当前场景属于缺陷修复类型。
	category: 'bugfix',

	// 创建独立工作区时需要叠加的场景代码层。
	overlay: 'overdue-boundary',

	// Runtime 判断任务是否完成时使用的验收标准。
	completionCriteria: [
		'截止时间与当前时间相等时不算逾期',
		'超过截止时间后返回逾期',
		'完成状态的任务永远不算逾期',
		'测试和类型检查全部通过'
	],

	/**
	 * 第一版任务计划。
	 *
	 * 初始计划沿用值班同学对“完成状态过滤”的怀疑。
	 * 第一次测试会证明该假设不成立，再通过 Replan 调整调查方向。
	 */
	initialSteps: [
		{
			id: 'reproduce-failure',
			title: '复现边界测试失败',
			description: '运行测试获得具体失败信息。',
			dependsOn: []
		},
		{
			id: 'inspect-completed-status',
			title: '检查完成状态过滤',
			description: '确认已完成任务是否被错误纳入逾期判断。',
			dependsOn: ['reproduce-failure']
		},
		{
			id: 'fix-completed-status',
			title: '修复完成状态判断',
			description: '根据检查结果修正完成状态过滤逻辑。',
			dependsOn: ['inspect-completed-status']
		},
		{
			id: 'verify-overdue-v1',
			title: '验证第一次修复',
			description: '运行测试确认逾期判断已经恢复正常。',
			dependsOn: ['fix-completed-status']
		}
	],

	// 限制 Agent 的文件修改范围，并定义本场景必须遵守的执行规则。
	workspacePolicy: {
		// 只允许修改逾期判断的实现文件。
		writablePaths: ['src/tasks/overdue.ts'],

		// 当前任务不允许删除任何文件。
		deletablePaths: [],

		instructions: [
			'先运行测试，验证值班同学对完成状态过滤的怀疑。',
			'如果测试证据与初始假设不一致，必须通过 Replan 调整调查方向。',
			'只修改逾期判断实现，不修改测试文件。'
		]
	},

	/**
	 * Replay 模式下使用的固定决策轨迹。
	 *
	 * 该轨迹模拟完整的缺陷修复过程：
	 * 复现失败 → 测试推翻初始假设 → 根据证据 Replan
	 * → 阅读边界实现 → 修改代码 → 执行验证 → 输出最终结论。
	 */
	playbook: [
		// 先执行测试，验证“完成状态过滤有问题”这个初始假设。
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'reproduce-failure',
			reasoning: '先运行测试，确认错误是否真的来自完成状态过滤。',
			completesStepIds: ['reproduce-failure']
		},

		/**
		 * 测试证明完成任务能够被正确排除，真正失败的是截止时间相等的边界。
		 *
		 * Replan 会取消基于错误假设生成的旧步骤，转向时间边界调查。
		 */
		{
			type: 'replan',
			reason:
				'测试证明完成状态过滤正常，真正失败的是截止时间相等的边界，需要调整调查方向。',
			cancelStepIds: [
				'inspect-completed-status',
				'fix-completed-status',
				'verify-overdue-v1'
			],
			newSteps: [
				{
					id: 'inspect-overdue-boundary',
					title: '检查截止时间边界',
					description: '对照失败测试检查日期比较逻辑。',
					dependsOn: ['reproduce-failure']
				},
				{
					id: 'fix-boundary',
					title: '修正截止时间比较符',
					description: '把相等时间从逾期条件中排除。',
					dependsOn: ['inspect-overdue-boundary']
				},
				{
					id: 'verify-overdue-v2',
					title: '验证边界修复',
					description: '在边界修复完成后运行测试、类型检查并确认 Diff。',
					dependsOn: ['fix-boundary']
				}
			]
		},

		// 根据 Plan v2 读取实际实现，检查逾期判断使用的时间比较条件。
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/overdue.ts' },
			stepId: 'inspect-overdue-boundary',
			reasoning: '读取逾期判断实现，检查时间比较符是否符合失败测试。'
		},

		// 读取失败测试，确认截止时间相等时的准确预期。
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'tests/overdue.test.ts' },
			stepId: 'inspect-overdue-boundary',
			reasoning: '读取失败用例，确认截止时间相等时不应该算作逾期。',
			completesStepIds: ['inspect-overdue-boundary']
		},

		// 将小于等于修改为严格小于，排除截止时间刚好相等的情况。
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/overdue.ts',
				replacements: [
					{
						search:
							"task.status !== 'done' && new Date(task.dueAt).getTime() <= now.getTime()",
						replacement:
							"task.status !== 'done' && new Date(task.dueAt).getTime() < now.getTime()"
					}
				]
			},
			stepId: 'fix-boundary',
			reasoning: '使用严格小于号，只把已经超过截止时间的任务标记为逾期。',
			completesStepIds: ['fix-boundary']
		},

		// 重新运行测试，验证时间边界和完成状态判断都符合预期。
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'verify-overdue-v2',
			reasoning: '重新运行测试确认边界和完成状态都正确。'
		},

		// 执行类型检查，确认本次修改没有引入类型错误。
		{
			type: 'action',
			toolName: 'run_typecheck',
			arguments: {},
			stepId: 'verify-overdue-v2',
			reasoning: '确认修复没有引入类型错误。'
		},

		// 查看最终代码差异，确认修改范围只包含逾期判断文件。
		{
			type: 'action',
			toolName: 'get_git_diff',
			arguments: {},
			stepId: 'verify-overdue-v2',
			reasoning: '检查修改是否只影响逾期判断。',
			completesStepIds: ['verify-overdue-v2']
		},

		// 所有计划步骤和验证条件满足后，输出最终结果。
		{
			type: 'final',
			summary: '逾期时间边界已经修复，并通过测试验证。'
		}
	],

	// Runtime 在任务结束时需要检查的预期结果。
	expected: {
		// 最终只允许 overdue.ts 发生修改。
		changedPaths: ['src/tasks/overdue.ts'],

		// 必须有测试和类型检查成功的验证记录。
		requireTests: true,
		requireTypecheck: true,

		// 必须发生一次 Replan，使最终计划版本升级为 Plan v2。
		requirePlanVersion: 2
	}
}

/**
 * “废弃代码清理”实验场景。
 *
 * 用于验证 Agent 是否能够先确认文件不存在引用，
 * 再通过 Human-in-the-Loop 获得人工批准，最后执行删除和回归验证。
 */
const legacyCleanup: ScenarioDefinition = {
	// 场景唯一标识，用于创建 Run 和加载对应工作区。
	id: 'legacy-cleanup',

	// 前端场景列表中展示的标题和简介。
	title: '审批后删除废弃代码',
	shortDescription: '确认文件没有引用后，请求人工批准删除并完成回归验证。',

	// Agent 本次需要完成的自然语言需求。
	requirement:
		'删除已经被 TaskService 替代的 legacy-task.mapper.ts，删除前必须确认没有引用并获得人工批准。',

	// 当前场景属于代码重构类型。
	category: 'refactor',

	// 创建工作区时需要叠加的场景代码层。
	overlay: 'legacy-cleanup',

	// Runtime 判断任务是否完成时使用的验收标准。
	completionCriteria: [
		'确认废弃文件没有任何代码引用',
		'删除操作经过人工批准',
		'目标文件已经从工作区删除',
		'测试和类型检查保持通过'
	],

	/**
	 * 初始任务计划。
	 *
	 * 整个任务分为引用检查、审批后删除和回归验证三个阶段，
	 * 后续步骤必须等待前置步骤完成后才能执行。
	 */
	initialSteps: [
		{
			id: 'inspect-legacy',
			title: '确认废弃文件及引用关系',
			description: '搜索文件名称和导出函数的引用。',
			dependsOn: []
		},
		{
			id: 'remove-legacy',
			title: '删除废弃文件',
			description: '获得人工批准后执行删除。',
			dependsOn: ['inspect-legacy']
		},
		{
			id: 'verify-cleanup',
			title: '验证清理结果',
			description: '运行测试、类型检查并检查 Diff。',
			dependsOn: ['remove-legacy']
		}
	],

	// 限制 Agent 可以修改或删除的文件，并声明删除前必须满足的条件。
	workspacePolicy: {
		// 本场景不允许修改任何现有文件内容。
		writablePaths: [],

		// 只允许删除指定的废弃文件。
		deletablePaths: ['src/legacy/legacy-task.mapper.ts'],

		instructions: [
			'删除前必须搜索 mapLegacyTask 的引用并读取目标文件。',
			'本场景只允许删除指定的 legacy 文件，不修改其他代码。',
			'delete_file 属于高风险工具，Runtime 会暂停并等待用户确认。'
		]
	},

	/**
	 * Replay 模式下使用的固定决策轨迹。
	 *
	 * 执行链路为：
	 * 搜索引用 → 读取目标文件 → 请求审批并删除
	 * → 运行测试和类型检查 → 检查最终 Diff。
	 */
	playbook: [
		// 搜索旧映射函数，确认是否仍有其他代码依赖该文件。
		{
			type: 'action',
			toolName: 'search_code',
			arguments: { query: 'mapLegacyTask' },
			stepId: 'inspect-legacy',
			reasoning: '先确认旧函数是否仍然被其他文件引用。'
		},

		// 读取目标文件，确认文件内容确实已经被现有实现替代。
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/legacy/legacy-task.mapper.ts' },
			stepId: 'inspect-legacy',
			reasoning: '读取文件确认它确实只包含废弃映射逻辑。',
			completesStepIds: ['inspect-legacy']
		},

		/**
		 * 删除已经确认无引用的废弃文件。
		 *
		 * delete_file 属于高风险工具，Runtime 在真正执行前会暂停 Run，
		 * 创建 pendingApproval，并等待用户批准或拒绝本次操作。
		 */
		{
			type: 'action',
			toolName: 'delete_file',
			arguments: { path: 'src/legacy/legacy-task.mapper.ts' },
			stepId: 'remove-legacy',
			reasoning: '删除已确认无引用的废弃代码文件。',
			completesStepIds: ['remove-legacy']
		},

		// 删除完成后运行测试，确认业务行为没有发生退化。
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'verify-cleanup',
			reasoning: '删除后运行测试，确认行为没有退化。'
		},

		// 执行类型检查，确认代码中不存在残留的导入或类型引用。
		{
			type: 'action',
			toolName: 'run_typecheck',
			arguments: {},
			stepId: 'verify-cleanup',
			reasoning: '检查是否还存在指向已删除文件的类型引用。'
		},

		// 查看最终代码差异，确认本次操作只删除了目标文件。
		{
			type: 'action',
			toolName: 'get_git_diff',
			arguments: {},
			stepId: 'verify-cleanup',
			reasoning: '确认最终 Diff 只删除了目标文件。',
			completesStepIds: ['verify-cleanup']
		},

		// 所有步骤和验证条件满足后，输出最终运行结果。
		{
			type: 'final',
			summary: '废弃映射器已在人工批准后删除，回归验证通过。'
		}
	],

	// Runtime 在任务结束时需要检查的预期结果。
	expected: {
		// 最终必须确认目标文件已经被删除。
		deletedPaths: ['src/legacy/legacy-task.mapper.ts'],

		// 必须存在测试和类型检查成功的验证记录。
		requireTests: true,
		requireTypecheck: true
	}
}

export const SCENARIOS: ScenarioDefinition[] = [
	priorityFilter,
	overdueBoundary,
	legacyCleanup
]

export function getScenario(id: string): ScenarioDefinition {
	const scenario = SCENARIOS.find((item) => item.id === id)

	if (!scenario) {
		throw new Error(`未知场景：${id}`)
	}

	return scenario
}

export type RunStatus =
	| 'created'
	| 'planning'
	| 'running'
	| 'waiting_approval'
	| 'completed'
	| 'completed_with_warnings'
	| 'stopped'
	| 'failed'
	| 'cancelled'
	| 'human_handoff'

export type RunMode = 'ai' | 'replay'

export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'cancelled'

export type TraceEventType =
	| 'run'
	| 'plan'
	| 'decision'
	| 'action'
	| 'observation'
	| 'validation'
	| 'recovery'
	| 'approval'
	| 'report'

export interface PlanStep {
	id: string
	title: string
	description: string
	status: PlanStepStatus
	dependsOn: string[]
	createdInVersion: number
	completedAt?: string
}

export interface PlanState {
	version: number
	goal: string
	status: 'active' | 'completed' | 'stopped'
	steps: PlanStep[]
}

export interface RunLimits {
	maxIterations: number
	maxToolCalls: number
	maxFilesChanged: number
	maxDurationMs: number
	maxSameAction: number
}

export interface RunUsage {
	iterations: number
	toolCalls: number
	commandRuns: number
	filesRead: number
	filesChanged: number
	approvalWaitMs: number
	recoveryCount: number
	modelCalls: number
	promptTokens: number
	completionTokens: number
	modelLatencyMs: number
}

export interface ToolAction {
	id: string
	toolName: ToolName
	arguments: Record<string, unknown>
	stepId?: string
	reasoning: string
	completesStepIds?: string[]
	recovery?: {
		maxRetries?: number
		retryDelayMs?: number
		fallbackTool?: ToolName
	}
}

export type ToolName =
	| 'list_files'
	| 'search_code'
	| 'read_file'
	| 'apply_patch'
	| 'delete_file'
	| 'install_dependency'
	| 'run_tests'
	| 'run_typecheck'
	| 'run_lint'
	| 'run_build'
	| 'get_git_diff'

export interface ToolObservation {
	id: string
	actionId: string
	toolName: ToolName
	ok: boolean
	summary: string
	data: Record<string, unknown>
	evidenceKey: string
	createdAt: string
}

export interface TraceEvent {
	id: string
	type: TraceEventType
	title: string
	summary: string
	status: 'info' | 'success' | 'warning' | 'error'
	createdAt: string
	stepId?: string
	toolName?: ToolName
	data?: Record<string, unknown>
}

export interface PendingApproval {
	action: ToolAction
	risk: 'high'
	title: string
	description: string
	requestedAt: string
}

export interface VerificationState {
	testsPassed: boolean | null
	typecheckPassed: boolean | null
	lintPassed: boolean | null
	buildPassed: boolean | null
	lastCommand?: string
	changedPaths: string[]
	deletedPaths: string[]
}

export interface FinalReport {
	status: RunStatus
	summary: string
	completedCriteria: string[]
	remainingIssues: string[]
	changedPaths: string[]
	deletedPaths: string[]
	verification: VerificationState
	stopReason: string
}

export interface AgentRun {
	id: string
	scenarioId: string
	title: string
	requirement: string
	mode: RunMode
	model: string | null
	status: RunStatus
	createdAt: string
	updatedAt: string
	startedAt?: string
	completedAt?: string
	completionCriteria: string[]
	plan: PlanState
	limits: RunLimits
	usage: RunUsage
	trace: TraceEvent[]
	observations: ToolObservation[]
	failures: ExecutionFailure[]
	pendingApproval: PendingApproval | null
	approvedActionIds: string[]
	rejectedActionIds: string[]
	actionFingerprints: Record<string, number>
	playbookCursor: number
	verification: VerificationState
	report: FinalReport | null
	stopReason: string | null
}

export interface ExecutionFailure {
	id: string
	actionId?: string
	toolName?: ToolName
	stepId?: string
	message: string
	createdAt: string
}

export interface ActionTemplate {
	type: 'action'
	toolName: ToolName
	arguments: Record<string, unknown>
	stepId?: string
	reasoning: string
	completesStepIds?: string[]
	recovery?: ToolAction['recovery']
}

export interface ReplanTemplate {
	type: 'replan'
	reason: string
	evidenceIds?: string[]
	cancelStepIds?: string[]
	newSteps: Array<Omit<PlanStep, 'status' | 'createdInVersion'>>
}

export interface FinalTemplate {
	type: 'final'
	summary: string
}

export type DecisionTemplate = ActionTemplate | ReplanTemplate | FinalTemplate

export type AgentDecision =
	| { type: 'action'; action: ToolAction }
	| ReplanTemplate
	| FinalTemplate

/**
 * Provider 单次决策调用的返回结果。
 *
 * 除了 Agent 的下一步决策，还包含决策来源、实际使用的模型、
 * 调用耗时以及 Token 消耗等运行统计信息。
 */
export interface ProviderResult {
	// Provider 返回的下一步决策，可能是 Action、Replan 或 Final。
	decision: AgentDecision

	// 当前决策的来源模式，用于区分 AI 动态决策和 Replay 固定轨迹。
	source: RunMode

	// 实际参与本次决策的模型名称；Replay 模式下通常为 null。
	model: string | null

	// Provider 完成本次决策所消耗的时间，单位为毫秒。
	latencyMs?: number

	// 模型调用产生的 Token 使用情况；Replay 模式下通常不存在。
	usage?: {
		// 输入给模型的 Prompt Token 数量。
		promptTokens: number

		// 模型生成决策所消耗的输出 Token 数量。
		completionTokens: number

		// 本次调用消耗的 Token 总数。
		totalTokens: number
	}
}

export interface WorkspacePolicy {
	/** 模型可以修改的文件。测试文件不在列表中，避免通过改测试伪造成功。 */
	writablePaths: string[]
	/** 只有这里列出的文件才能提交删除审批。 */
	deletablePaths: string[]
	/** 传给模型的场景约束，用于缩小任务范围。 */
	instructions: string[]
}

export interface ScenarioDefinition {
	id: string
	title: string
	shortDescription: string
	requirement: string
	category: 'feature' | 'bugfix' | 'refactor'
	overlay?: string
	completionCriteria: string[]
	initialSteps: Array<Omit<PlanStep, 'status' | 'createdInVersion'>>
	playbook: DecisionTemplate[]
	workspacePolicy: WorkspacePolicy
	expected: {
		changedPaths?: string[]
		deletedPaths?: string[]
		requireTests?: boolean
		requireTypecheck?: boolean
		requirePlanVersion?: number
	}
}

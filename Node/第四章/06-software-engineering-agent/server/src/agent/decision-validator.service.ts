import { Injectable } from '@nestjs/common'
import type {
	AgentDecision,
	AgentRun,
	ToolAction,
	ToolName
} from './agent.types'
import { getScenario } from './scenarios'

const TOOL_NAMES: ToolName[] = [
	'list_files',
	'search_code',
	'read_file',
	'apply_patch',
	'delete_file',
	'run_tests',
	'run_typecheck',
	'run_lint',
	'run_build',
	'get_git_diff'
]

/** 在模型决策进入 Runtime 前检查工具、参数、步骤和场景边界。 */
@Injectable()
export class DecisionValidatorService {
	validate(run: AgentRun, decision: AgentDecision): void {
		if (decision.type === 'action') {
			// Action 决策必须引用已知工具、步骤和参数，并遵守场景的 workspacePolicy。
			this.validateAction(run, decision.action)
			return
		}

		if (decision.type === 'replan') {
			// Replan 决策必须引用已知证据、步骤，并遵守场景的 workspacePolicy。
			this.validateReplan(run, decision)
			return
		}

		if (!decision.summary.trim()) throw new Error('Final summary 不能为空。')
	}

	/**
	 * 校验模型提出的工具调用 Action 是否合法。
	 *
	 * 主要检查：
	 * 1. 工具是否在允许调用的工具列表中；
	 * 2. Action 是否包含有效的推理说明；
	 * 3. 关联的计划步骤是否真实存在；
	 * 4. 不同工具的参数格式是否符合要求；
	 * 5. 文件修改和删除操作是否符合当前场景的权限策略。
	 *
	 * @param run 当前 Agent Run State
	 * @param action 模型提出的工具调用 Action
	 */
	private validateAction(run: AgentRun, action: ToolAction): void {
		// 模型只能调用系统明确开放的工具。
		if (!TOOL_NAMES.includes(action.toolName)) {
			throw new Error(`模型提出了未开放的工具：${String(action.toolName)}`)
		}

		// 每个 Action 都必须说明选择该工具的原因。
		if (!action.reasoning.trim()) {
			throw new Error('Action reasoning 不能为空。')
		}

		// 如果 Action 关联了当前计划步骤，则该步骤必须真实存在。
		if (
			action.stepId &&
			!run.plan.steps.some((step) => step.id === action.stepId)
		) {
			throw new Error(`Action 引用了不存在的步骤：${action.stepId}`)
		}

		// 校验工具执行成功后准备标记为完成的步骤是否存在。
		for (const stepId of action.completesStepIds ?? []) {
			if (!run.plan.steps.some((step) => step.id === stepId)) {
				throw new Error(`Action 准备完成不存在的步骤：${stepId}`)
			}
		}

		// 获取当前场景配置，用于校验工作区操作权限。
		const scenario = getScenario(run.scenarioId)

		// 工具参数由不同工具自行完成针对性校验。
		const args = action.arguments

		// 搜索代码时必须提供非空 query。
		if (action.toolName === 'search_code') {
			requireString(args.query, 'query')
		}

		// 读取文件时必须提供非空文件路径。
		if (action.toolName === 'read_file') {
			requireString(args.path, 'path')
		}

		if (action.toolName === 'apply_patch') {
			// 修改文件时必须明确指定目标文件路径。
			const path = requireString(args.path, 'path')

			// 只能修改当前场景工作区策略中允许写入的文件。
			if (!scenario.workspacePolicy.writablePaths.includes(path)) {
				throw new Error(`当前场景不允许修改文件：${path}`)
			}

			const replacements = args.replacements

			// 单次补丁必须包含 1 到 6 个文本替换操作。
			if (
				!Array.isArray(replacements) ||
				replacements.length === 0 ||
				replacements.length > 6
			) {
				throw new Error('apply_patch 的 replacements 数量必须在 1 到 6 之间。')
			}

			// 逐项校验文本替换规则的数据结构。
			for (const item of replacements) {
				const replacement = item as Record<string, unknown>

				// search 表示需要在源文件中查找的原始文本。
				requireString(replacement.search, 'replacement.search')

				// replacement 可以是空字符串，但数据类型必须是字符串。
				if (typeof replacement.replacement !== 'string') {
					throw new Error('replacement.replacement 必须是字符串。')
				}
			}
		}

		if (action.toolName === 'delete_file') {
			// 删除文件时必须提供目标文件路径。
			const path = requireString(args.path, 'path')

			// 只能删除当前场景明确允许删除的文件。
			if (!scenario.workspacePolicy.deletablePaths.includes(path)) {
				throw new Error(`当前场景不允许删除文件：${path}`)
			}
		}

		// 运行测试、读取 Git Diff 和列出文件等工具不接收任何参数。
		if (
			action.toolName.startsWith('run_') ||
			action.toolName === 'get_git_diff' ||
			action.toolName === 'list_files'
		) {
			if (Object.keys(args).length > 0) {
				throw new Error(`${action.toolName} 不接收参数。`)
			}
		}
	}

	/**
	 * 校验 Replan 决策是否合法。
	 *
	 * 主要检查：
	 * 1. 是否说明了重新规划的原因；
	 * 2. 新增步骤数量是否符合限制；
	 * 3. 是否引用了真实存在的触发证据；
	 * 4. 新步骤字段是否完整，ID 是否重复。
	 *
	 * @param run 当前 Agent Run State
	 * @param decision Provider 返回的 Replan 决策
	 */
	private validateReplan(
		run: AgentRun,
		decision: Extract<AgentDecision, { type: 'replan' }>
	): void {
		// Replan 必须明确说明为什么需要调整当前计划。
		if (!decision.reason.trim()) {
			throw new Error('Replan reason 不能为空。')
		}

		// 限制单次重新规划的范围，避免一次性对计划进行过大修改。
		if (!decision.newSteps.length || decision.newSteps.length > 3) {
			throw new Error('一次 Replan 必须新增 1 到 3 个步骤。')
		}

		// Replan 必须引用导致计划调整的 Observation 或 Failure。
		const evidenceIds = decision.evidenceIds ?? []

		if (!evidenceIds.length) {
			throw new Error('Replan 必须引用触发调整的证据。')
		}

		// 校验每个证据 ID 是否真实存在于当前运行记录中。
		for (const id of evidenceIds) {
			const observation = run.observations.find((item) => item.id === id)
			const failure = run.failures.find((item) => item.id === id)

			if (!observation && !failure) {
				throw new Error(`Replan 引用了不存在的证据：${id}`)
			}
		}

		// 收集原计划中的步骤 ID，用于检测新旧步骤之间的 ID 冲突。
		const existingIds = new Set(run.plan.steps.map((step) => step.id))

		// 记录本次 Replan 新增的步骤 ID，检测新增步骤内部是否重复。
		const newIds = new Set<string>()

		for (const step of decision.newSteps) {
			// 每个新增步骤都必须包含最基本的身份和任务描述信息。
			if (
				!step.id?.trim() ||
				!step.title?.trim() ||
				!step.description?.trim()
			) {
				throw new Error('Replan 新步骤缺少 id、title 或 description。')
			}

			// 新步骤不能与原计划步骤重复，也不能在本次 Replan 中相互重复。
			if (existingIds.has(step.id) || newIds.has(step.id)) {
				throw new Error(`Replan 步骤 ID 重复：${step.id}`)
			}

			// 当前步骤校验通过后，记录其 ID。
			newIds.add(step.id)
		}
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${field} 必须是非空字符串。`)
	}
	return value
}

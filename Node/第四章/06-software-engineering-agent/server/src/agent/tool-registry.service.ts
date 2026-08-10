import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type {
	AgentRun,
	ToolAction,
	ToolName,
	ToolObservation
} from './agent.types'
import { CommandService } from './command.service'
import { WorkspaceService } from './workspace.service'

interface ToolDescriptor {
	name: ToolName
	description: string
	risk: 'low' | 'high'
}

const TOOLS: ToolDescriptor[] = [
	{ name: 'list_files', description: '列出工作区文件', risk: 'low' },
	{ name: 'search_code', description: '在工作区中搜索代码', risk: 'low' },
	{ name: 'read_file', description: '读取一个文本文件', risk: 'low' },
	{ name: 'apply_patch', description: '对文件执行唯一匹配替换', risk: 'low' },
	{ name: 'delete_file', description: '删除工作区文件', risk: 'high' },
	{ name: 'install_dependency', description: '安装白名单依赖', risk: 'high' },
	{ name: 'run_tests', description: '运行工作区测试', risk: 'low' },
	{
		name: 'run_typecheck',
		description: '运行 TypeScript 类型检查',
		risk: 'low'
	},
	{ name: 'run_lint', description: '运行代码风格检查', risk: 'low' },
	{ name: 'run_build', description: '构建工作区代码', risk: 'low' },
	{
		name: 'get_git_diff',
		description: '查看相对初始工作区的代码变化',
		risk: 'low'
	}
]

@Injectable()
export class ToolRegistryService {
	constructor(
		@Inject(WorkspaceService)
		private readonly workspaces: WorkspaceService,
		@Inject(CommandService)
		private readonly commands: CommandService
	) {}

	list(): ToolDescriptor[] {
		return TOOLS.map((item) => ({ ...item }))
	}

	/**
	 * 判断指定工具是否属于高风险操作，需要人工审批后才能执行。
	 *
	 * @param toolName 工具名称
	 * @returns 工具风险等级为 high 时返回 true，否则返回 false
	 */
	requiresApproval(toolName: ToolName): boolean {
		// 根据工具名称查找对应配置，并判断其风险等级是否为 high。
		return TOOLS.find((item) => item.name === toolName)?.risk === 'high'
	}

	/**
	 * 执行一次工具调用，并将底层结果转换为标准化 Observation。
	 *
	 * @param run 当前 Agent Run
	 * @param action 本轮需要执行的工具 Action
	 * @returns 工具执行后生成的 Observation
	 */
	async execute(run: AgentRun, action: ToolAction): Promise<ToolObservation> {
		// 执行具体工具，获得结构化返回数据。
		const data = await this.executeTool(run, action)

		// 将工具结果包装成 Runtime 统一使用的 Observation。
		return {
			// 当前 Observation 的唯一标识。
			id: randomUUID(),

			// 关联产生该结果的 Action。
			actionId: action.id,

			// 记录本次实际执行的工具名称。
			toolName: action.toolName,

			// executeTool 正常返回，表示工具执行成功。
			ok: true,

			// 根据工具名称和返回数据生成人类可读的结果摘要。
			summary: summarize(action.toolName, data),

			// 保存工具返回的完整结构化数据。
			data,

			// 生成证据标识，用于区分和追踪不同工具调用结果。
			evidenceKey: `${action.toolName}:${stableStringify(
				action.arguments
			)}:${run.usage.toolCalls}`,

			// 记录 Observation 的创建时间。
			createdAt: new Date().toISOString()
		}
	}

	/**
	 * 根据 Action 中的工具名称执行对应的底层操作。
	 *
	 * 该方法负责解析并校验工具参数，再将调用分发给工作区服务
	 * 或命令执行服务，最终返回统一的结构化工具结果。
	 *
	 * @param run 当前 Agent Run 的运行状态
	 * @param action 本轮需要执行的工具 Action
	 * @returns 工具执行后返回的结构化数据
	 */
	private async executeTool(
		run: AgentRun,
		action: ToolAction
	): Promise<Record<string, unknown>> {
		// 取出模型或 Replay 轨迹提供的工具参数。
		const args = action.arguments

		// 只允许执行 Runtime 明确注册和实现的工具。
		switch (action.toolName) {
			case 'list_files': {
				// 获取当前 Run 独立工作区中的全部文件。
				const files = await this.workspaces.listFiles(run.id)

				return {
					files,
					count: files.length
				}
			}

			case 'search_code': {
				// 校验 query 参数必须是非空字符串。
				const query = requireString(args.query, 'query')

				// 在当前工作区中搜索包含指定内容的代码位置。
				const matches = await this.workspaces.search(run.id, query)

				return {
					query,
					matches,
					count: matches.length
				}
			}

			case 'read_file': {
				// 校验并获取需要读取的相对文件路径。
				const path = requireString(args.path, 'path')

				// 从当前 Run 的独立工作区读取文件内容。
				const content = await this.workspaces.read(run.id, path)

				// 记录本次运行累计读取的文件数量。
				run.usage.filesRead += 1

				return {
					path,
					content,
					lineCount: content.split('\n').length
				}
			}

			case 'apply_patch': {
				// 校验需要修改的目标文件路径。
				const path = requireString(args.path, 'path')

				// 获取需要执行的文本替换规则。
				const replacements = args.replacements as Array<{
					search: string
					replacement: string
				}>

				// 在目标文件中依次应用精确文本替换。
				const result = await this.workspaces.applyReplacements(
					run.id,
					path,
					replacements
				)

				return {
					path,
					...result
				}
			}

			case 'delete_file': {
				// 校验需要删除的目标文件路径。
				const path = requireString(args.path, 'path')

				/**
				 * 删除当前工作区中的指定文件。
				 *
				 * delete_file 是否需要人工批准，以及目标路径是否允许删除，
				 * 应当在进入该方法之前由 Runtime 和工作区策略完成校验。
				 */
				await this.workspaces.delete(run.id, path)

				return {
					path,
					deleted: true
				}
			}

			case 'install_dependency':
				/**
				 * 课程案例只演示高风险依赖安装的审批流程，
				 * 不真正访问外部网络或修改项目依赖。
				 */
				throw new Error('当前课程案例只演示依赖安装审批，不执行真实网络安装。')

			case 'run_tests':
				// 在当前工作区中执行完整测试命令。
				return {
					...(await this.commands.runTests(run.id))
				}

			case 'run_typecheck':
				// 执行 TypeScript 类型检查。
				return {
					...(await this.commands.runTypecheck(run.id))
				}

			case 'run_lint':
				// 执行代码规范检查。
				return {
					...(await this.commands.runLint(run.id))
				}

			case 'run_build':
				// 执行项目构建，验证代码能否正常编译和产出。
				return {
					...(await this.commands.runBuild(run.id))
				}

			case 'get_git_diff':
				// 对比原始快照，返回当前工作区中的文件变更情况。
				return this.workspaces.getChanges(run.id)

			default:
				// 拒绝执行所有未注册或未明确允许的工具。
				throw new Error(`不允许执行工具：${String(action.toolName)}`)
		}
	}
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${name} 必须是非空字符串。`)
	}
	return value
}

function summarize(toolName: ToolName, data: Record<string, unknown>): string {
	if (
		toolName === 'run_tests' ||
		toolName === 'run_typecheck' ||
		toolName === 'run_lint' ||
		toolName === 'run_build'
	) {
		return `${toolName} ${data.passed ? '通过' : '未通过'}，耗时 ${data.durationMs}ms。`
	}
	if (toolName === 'read_file') return `已读取 ${data.path}。`
	if (toolName === 'search_code') return `找到 ${data.count} 条代码匹配。`
	if (toolName === 'list_files') return `工作区包含 ${data.count} 个文件。`
	if (toolName === 'apply_patch') return `已修改 ${data.path}。`
	if (toolName === 'delete_file') return `已删除 ${data.path}。`
	if (toolName === 'get_git_diff') {
		const changed = (data.changedPaths as string[]).length
		const deleted = (data.deletedPaths as string[]).length
		return `Diff 包含 ${changed} 个修改文件和 ${deleted} 个删除文件。`
	}
	return `${toolName} 执行完成。`
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${key}:${stableStringify(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

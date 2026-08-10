import { Inject, Injectable } from '@nestjs/common'
import type { AgentRun } from './agent.types'
import { WorkspaceService } from './workspace.service'

@Injectable()
export class RunStoreService {
	private readonly runs = new Map<string, AgentRun>()

	constructor(
		@Inject(WorkspaceService)
		private readonly workspaces: WorkspaceService
	) {}

	list(): AgentRun[] {
		return [...this.runs.values()]
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			.map((run) => structuredClone(run))
	}

	get(id: string): AgentRun {
		const run = this.runs.get(id)

		if (!run) {
			throw new Error(`Agent Run 不存在：${id}`)
		}

		return run
	}

	/**
	 * 保存 Agent Run 的最新状态。
	 *
	 * 该方法会更新时间戳，同时更新内存中的运行记录，
	 * 并将完整状态持久化到对应的独立工作区。
	 *
	 * @param run 需要保存的 Agent Run
	 */
	async save(run: AgentRun): Promise<void> {
		// 每次保存前刷新更新时间，记录 Run 最近一次发生变化的时间。
		run.updatedAt = new Date().toISOString()

		// 更新内存中的运行状态，便于后续快速读取。
		this.runs.set(run.id, run)

		// 将 Run 状态持久化到工作区，避免进程内状态成为唯一数据来源。
		await this.workspaces.persistRun(run.id, run)
	}
}

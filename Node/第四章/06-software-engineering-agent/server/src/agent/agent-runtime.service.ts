import { Inject, Injectable } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import type {
	AgentDecision,
	AgentRun,
	FinalReport,
	PlanStep,
	ProviderResult,
	RunMode,
	RunStatus,
	ToolAction,
	ToolObservation,
	TraceEvent
} from './agent.types'
import { AgentProviderService } from './agent-provider.service'
import { DecisionValidatorService } from './decision-validator.service'
import { ResultValidatorService } from './result-validator.service'
import { RunStoreService } from './run-store.service'
import { getScenario } from './scenarios'
import { ToolRegistryService } from './tool-registry.service'
import { WorkspaceService } from './workspace.service'

const DEFAULT_LIMITS = {
	maxIterations: 30,
	maxToolCalls: 25,
	maxFilesChanged: 8,
	maxDurationMs: 120_000,
	maxSameAction: 2
}

const ACTIVE_STATUSES: RunStatus[] = [
	'created',
	'planning',
	'running',
	'waiting_approval'
]

@Injectable()
export class AgentRuntimeService {
	private readonly activeExecutions = new Set<string>()

	constructor(
		@Inject(WorkspaceService)
		private readonly workspaces: WorkspaceService,
		@Inject(RunStoreService)
		private readonly store: RunStoreService,
		@Inject(AgentProviderService)
		private readonly provider: AgentProviderService,
		@Inject(DecisionValidatorService)
		private readonly decisionValidator: DecisionValidatorService,
		@Inject(ToolRegistryService)
		private readonly tools: ToolRegistryService,
		@Inject(ResultValidatorService)
		private readonly validator: ResultValidatorService
	) {}

	listRuns(): AgentRun[] {
		return this.store.list()
	}

	getRun(id: string): AgentRun {
		return structuredClone(this.store.get(id))
	}

	/**
	 * 创建并启动一次新的 Agent Run。
	 *
	 * 该方法负责校验运行参数、初始化运行状态、创建独立工作区、
	 * 保存初始执行轨迹，并将任务提交给调度器继续执行。
	 *
	 * @param scenarioId 要运行的场景 ID
	 * @param options 可选运行配置，包括自定义需求和运行模式
	 * @returns 创建完成后的 Agent Run
	 */
	async createRun(
		scenarioId: string,
		options: { requirement?: string; mode?: RunMode } = {}
	): Promise<AgentRun> {
		// 根据场景 ID 获取预设场景，场景不存在时由 getScenario 抛出异常。
		const scenario = getScenario(scenarioId)

		// 默认使用 Replay 模式，避免未明确指定时直接产生模型调用。
		const mode = options.mode ?? 'replay'

		// 优先使用用户输入的需求，否则使用场景预设需求。
		const requirement = (options.requirement ?? scenario.requirement).trim()

		// 对最终使用的任务需求进行基础校验。
		if (!requirement) throw new Error('任务需求不能为空。')
		if (requirement.length > 1_000)
			throw new Error('任务需求不能超过 1000 个字符。')

		// 确认当前 Provider 支持并且能够使用指定的运行模式。
		this.provider.assertAvailable(mode)

		// 为本次运行生成唯一标识，并统一记录初始化时间。
		const id = randomUUID()
		const now = new Date().toISOString()

		// 初始化本次 Agent Run 的完整运行状态。
		const run: AgentRun = {
			id,
			scenarioId,
			title: scenario.title,
			requirement,
			mode,

			// 模型信息会在实际发生模型调用后补充。
			model: null,

			// 创建阶段首先进入规划状态。
			status: 'planning',
			createdAt: now,
			updatedAt: now,
			startedAt: now,

			// 使用场景预设的任务完成标准。
			completionCriteria: scenario.completionCriteria,

			// 创建第一版任务计划，并将所有初始步骤重置为待执行状态。
			plan: {
				version: 1,
				goal: requirement,
				status: 'active',
				steps: scenario.initialSteps.map((step) => ({
					...structuredClone(step),
					status: 'pending',
					createdInVersion: 1
				}))
			},

			// 为每次运行复制一份独立限制配置，避免共享对象被修改。
			limits: { ...DEFAULT_LIMITS },

			// 初始化运行过程中的资源消耗和执行统计。
			usage: {
				iterations: 0,
				toolCalls: 0,
				commandRuns: 0,
				filesRead: 0,
				filesChanged: 0,
				approvalWaitMs: 0,
				recoveryCount: 0,
				modelCalls: 0,
				promptTokens: 0,
				completionTokens: 0,
				modelLatencyMs: 0
			},

			// 初始化运行轨迹、工具观察结果和失败记录。
			trace: [],
			observations: [],
			failures: [],

			// 初始化人工审批相关状态。
			pendingApproval: null,
			approvedActionIds: [],
			rejectedActionIds: [],

			// 用于识别重复 Action，避免 Agent 反复执行相同操作。
			actionFingerprints: {},

			// Replay 模式下用于记录当前执行到预设轨迹的哪个位置。
			playbookCursor: 0,

			// 初始化代码修改后的验证结果。
			verification: {
				testsPassed: null,
				typecheckPassed: null,
				lintPassed: null,
				buildPassed: null,
				changedPaths: [],
				deletedPaths: []
			},

			// 任务结束后生成的报告和停止原因。
			report: null,
			stopReason: null
		}

		// 为本次 Run 创建独立工作区，隔离文件读取和修改操作。
		await this.workspaces.create(id, scenario)

		// 记录初始计划，便于前端展示 Plan v1 的具体内容。
		this.addTrace(run, {
			type: 'plan',
			title: '创建任务计划',
			summary: `Plan v1 包含 ${run.plan.steps.length} 个步骤。`,
			status: 'info',
			data: {
				version: 1,
				steps: run.plan.steps,
				mode
			}
		})

		// 记录本次运行使用的执行模式及其行为差异。
		this.addTrace(run, {
			type: 'run',
			title: mode === 'ai' ? '使用 AI 模式执行' : '使用 Replay 模式执行',
			summary:
				mode === 'ai'
					? '每一轮 Action 由 DeepSeek 模型根据当前代码和 Observation 动态生成。'
					: '按照预设决策轨迹复现实验，不产生模型调用费用。',
			status: 'info',
			data: { requirement }
		})

		// 初始化工作完成后，将 Run 切换为运行状态并持久化。
		run.status = 'running'
		await this.store.save(run)

		// 将任务加入调度队列，由 Runtime 在后续执行循环中继续处理。
		this.schedule(id)

		// 返回存储层中的最新 Run，确保结果与持久化状态一致。
		return this.getRun(id)
	}

	/**
	 * 处理当前 Agent Run 的人工审批结果。
	 *
	 * 当用户拒绝时，停止本次运行并记录被拒绝的 Action；
	 * 当用户批准时，恢复运行状态并重新调度 Agent 执行。
	 *
	 * @param runId 需要处理审批的 Agent Run ID
	 * @param approved 用户是否批准当前高风险操作
	 * @returns 更新后的 Agent Run
	 */
	async decideApproval(runId: string, approved: boolean): Promise<AgentRun> {
		// 获取当前运行状态以及等待审批的操作。
		const run = this.store.get(runId)
		const pending = run.pendingApproval

		// 只有处于等待审批状态，并且确实存在待审批操作时才能继续。
		if (!pending || run.status !== 'waiting_approval') {
			throw new Error('当前 Agent Run 没有等待处理的审批。')
		}

		// 用户拒绝执行当前高风险操作。
		if (!approved) {
			// 清除待审批信息，避免该操作再次进入审批流程。
			run.pendingApproval = null

			// 记录被用户拒绝的 Action ID。
			run.rejectedActionIds.push(pending.action.id)

			// 将拒绝结果写入运行轨迹。
			this.addTrace(run, {
				type: 'approval',
				title: '用户拒绝高风险操作',
				summary: `${pending.action.toolName} 未执行，任务已停止。`,
				status: 'warning',
				toolName: pending.action.toolName
			})

			// 拒绝高风险操作后，终止当前 Agent Run。
			this.finish(run, 'stopped', '用户拒绝了高风险操作。')

			// 持久化最终运行状态。
			await this.store.save(run)

			return this.getRun(runId)
		}

		// 用户思考和确认所花的时间不计入 Agent 的执行时间预算。
		run.usage.approvalWaitMs =
			(run.usage.approvalWaitMs ?? 0) +
			Math.max(0, Date.now() - Date.parse(pending.requestedAt))

		// 记录已获得用户批准的 Action，避免重复请求审批。
		run.approvedActionIds.push(pending.action.id)

		// 将运行状态恢复为 running，允许 Agent 继续执行。
		run.status = 'running'

		// 将批准结果写入运行轨迹。
		this.addTrace(run, {
			type: 'approval',
			title: '用户批准高风险操作',
			summary: `${pending.action.toolName} 已获准执行。`,
			status: 'success',
			toolName: pending.action.toolName
		})

		// 先保存审批后的状态，再继续调度后续执行。
		await this.store.save(run)

		// 将当前 Run 重新加入执行调度。
		this.schedule(runId)

		return this.getRun(runId)
	}

	async cancelRun(runId: string): Promise<AgentRun> {
		const run = this.store.get(runId)

		if (!ACTIVE_STATUSES.includes(run.status)) {
			return this.getRun(runId)
		}

		run.pendingApproval = null
		this.finish(run, 'cancelled', '用户主动停止了本次 Agent Run。')
		await this.store.save(run)
		return this.getRun(runId)
	}

	/**
	 * 将指定的 Agent Run 加入执行队列。
	 */
	private schedule(runId: string): void {
		setTimeout(() => void this.execute(runId), 80)
	}

	/**
	 * 执行指定 Agent Run 的主循环。
	 *
	 * Runtime 会持续获取 Provider 决策，并依次处理 Replan、Final 和 Action。
	 * 当预算耗尽、需要人工审批、任务完成或发生异常时，执行循环结束。
	 *
	 * @param runId 要执行的 Agent Run ID
	 */
	private async execute(runId: string): Promise<void> {
		// 防止同一个 Run 被多个调度任务同时执行。
		if (this.activeExecutions.has(runId)) return
		this.activeExecutions.add(runId)

		try {
			// 获取本次运行的可变状态对象。
			const run = this.store.get(runId)

			// 只要 Run 仍处于运行状态，就持续执行 Agent 决策循环。
			while (run.status === 'running') {
				// 每轮开始前检查迭代次数、工具调用量、Token 和运行时长等预算。
				const budgetReason = this.checkBudgets(run)

				if (budgetReason) {
					// 预算耗尽时停止自动执行，将任务交给人工处理。
					this.finish(run, 'human_handoff', budgetReason)
					await this.store.save(run)
					break
				}

				// 记录本轮 Agent 循环次数。
				run.usage.iterations += 1

				/**
				 * 检查是否存在已经获得人工批准、但尚未真正执行的 Action。
				 *
				 * 如果存在，则直接恢复该 Action；
				 * 否则请求 Provider 根据当前 Run 状态生成下一步决策。
				 */
				const approvedAction = this.getApprovedPendingAction(run)
				const providerResult: ProviderResult = approvedAction
					? {
							decision: {
								type: 'action',
								action: approvedAction
							},
							source: run.mode,
							model: run.model
						}
					: await this.provider.next(run)

				// 记录本次 Provider 调用的来源、模型和资源消耗。
				this.recordProviderResult(run, providerResult)

				// 在执行前校验决策结构、计划依赖和工具调用是否合法。
				this.decisionValidator.validate(run, providerResult.decision)

				const decision = providerResult.decision

				// Replan 表示根据最新 Observation 调整任务计划。
				if (decision.type === 'replan') {
					this.applyReplan(run, decision)

					// Replay 模式需要手动推进固定决策轨迹的位置。
					if (providerResult.source === 'replay') {
						run.playbookCursor += 1
					}

					await this.store.save(run)
					await pause()
					continue
				}

				// Final 表示 Provider 认为任务已经可以结束。
				if (decision.type === 'final') {
					await this.complete(run, decision.summary)
					await this.store.save(run)
					break
				}

				// 剩余情况为 Action，需要调用具体工具执行。
				const action = decision.action
				const fingerprint = fingerprintAction(action)

				/**
				 * 统计相同 Action 的重复执行次数。
				 *
				 * 已批准的 Action 只是从等待状态恢复，不应再次累计一次重复次数；
				 * 新生成的 Action 才会更新对应指纹的计数。
				 */
				const repeated = approvedAction
					? (run.actionFingerprints[fingerprint] ?? 1)
					: (run.actionFingerprints[fingerprint] ?? 0) + 1

				if (!approvedAction) {
					run.actionFingerprints[fingerprint] = repeated
				}

				// 将本轮工具决策写入运行轨迹。
				this.addTrace(run, {
					type: 'decision',
					title: approvedAction
						? '继续执行已经批准的 Action'
						: providerResult.source === 'ai'
							? '模型提出下一步 Action'
							: 'Replay 返回下一步 Action',
					summary: action.reasoning,
					status: 'info',
					stepId: action.stepId,
					toolName: action.toolName,
					data: {
						arguments: action.arguments
					}
				})

				// 相同 Action 重复过多通常意味着 Agent 陷入循环。
				if (repeated > run.limits.maxSameAction) {
					this.finish(run, 'human_handoff', '相同 Action 重复次数超过预算。')
					await this.store.save(run)
					break
				}

				/**
				 * 高风险工具必须经过人工批准。
				 *
				 * 如果当前 Action 尚未被批准，则保存审批请求，
				 * 将 Run 切换为 waiting_approval，并暂停执行循环。
				 */
				if (
					this.tools.requiresApproval(action.toolName) &&
					!run.approvedActionIds.includes(action.id)
				) {
					run.pendingApproval = {
						action,
						risk: 'high',
						title: '需要人工批准高风险操作',
						description: `Agent 准备执行 ${action.toolName}：${action.reasoning}`,
						requestedAt: new Date().toISOString()
					}

					run.status = 'waiting_approval'

					this.addTrace(run, {
						type: 'approval',
						title: '执行已暂停，等待人工审批',
						summary: run.pendingApproval.description,
						status: 'warning',
						stepId: action.stepId,
						toolName: action.toolName,
						data: {
							arguments: action.arguments
						}
					})

					await this.store.save(run)
					break
				}

				// 执行已经通过校验和审批的工具调用，并记录 Observation。
				await this.executeAction(run, action, providerResult.source)

				// 每个 Action 执行完成后立即保存最新运行状态。
				await this.store.save(run)

				// 主动让出事件循环，避免连续执行阻塞其他请求。
				await pause()
			}
		} catch (error) {
			// 捕获 Provider、校验器或工具执行过程中的未处理异常。
			const run = this.store.get(runId)

			this.finish(
				run,
				'failed',
				error instanceof Error ? error.message : 'Agent Runtime 执行失败。'
			)

			await this.store.save(run)
		} finally {
			// 无论正常结束还是异常退出，都要释放当前 Run 的执行锁。
			this.activeExecutions.delete(runId)
		}
	}

	/**
	 * 执行一次经过校验和审批的工具 Action。
	 *
	 * 该方法负责记录工具调用、执行真实工具、校验 Observation、
	 * 更新计划步骤与验证状态，并在失败时触发自动恢复或人工接管。
	 *
	 * @param run 当前 Agent Run 的运行状态
	 * @param action 本轮需要执行的工具 Action
	 * @param source 当前决策来源，用于区分 AI 和 Replay 模式
	 */
	private async executeAction(
		run: AgentRun,
		action: ToolAction,
		source: RunMode
	): Promise<void> {
		// 统计本次工具调用。
		run.usage.toolCalls += 1

		// 以 run_ 开头的工具通常会执行测试、构建或类型检查等命令。
		if (action.toolName.startsWith('run_')) {
			run.usage.commandRuns += 1
		}

		// 将当前 Action 对应的计划步骤标记为执行中。
		this.markStepRunning(run, action.stepId)

		// 记录工具即将执行以及本次调用使用的参数。
		this.addTrace(run, {
			type: 'action',
			title: `执行工具：${action.toolName}`,
			summary: formatArguments(action.arguments),
			status: 'info',
			stepId: action.stepId,
			toolName: action.toolName,
			data: {
				arguments: action.arguments
			}
		})

		try {
			// 调用真实工具，并获得标准化的 Observation。
			const observation = await this.tools.execute(run, action)

			// 校验工具结果是否完整、可信并且满足当前 Action 的预期。
			const validation = this.validator.validate(action, observation)

			// 记录工具返回的原始 Observation。
			this.addTrace(run, {
				type: 'observation',
				title: '工具返回 Observation',
				summary: observation.summary,
				status: observationStatus(observation),
				stepId: action.stepId,
				toolName: action.toolName,
				data: observation.data
			})

			// 单独记录 Observation 的校验结果，便于定位无效结果。
			this.addTrace(run, {
				type: 'validation',
				title: validation.valid
					? 'Observation 校验通过'
					: 'Observation 校验失败',
				summary: validation.summary,
				status: validation.valid ? 'success' : 'error',
				stepId: action.stepId,
				toolName: action.toolName,
				data: {
					code: validation.code
				}
			})

			// 无效 Observation 按工具执行失败处理，不进入后续运行上下文。
			if (!validation.valid) {
				throw new Error(validation.summary)
			}

			// 只有通过校验的 Observation 才能保存为后续决策证据。
			run.observations.push(observation)

			// 根据测试、类型检查、Diff 等工具结果更新最终验证状态。
			this.updateVerification(run, action, observation)

			// 如果当前 Action 来自人工审批流程，执行成功后清除待审批状态。
			if (run.pendingApproval?.action.id === action.id) {
				run.pendingApproval = null
			}

			// 将 Action 声明完成的计划步骤更新为已完成。
			for (const stepId of action.completesStepIds ?? []) {
				this.completeStep(run, stepId)
			}

			// Replay 模式执行成功后，推进到固定决策轨迹的下一项。
			if (source === 'replay') {
				run.playbookCursor += 1
			}
		} catch (error) {
			// 工具异常和 Observation 校验失败都计入恢复次数。
			run.usage.recoveryCount += 1

			const message = error instanceof Error ? error.message : '工具执行失败。'

			// 保存结构化失败记录，供模型重新决策或人工排查。
			const failure = {
				id: randomUUID(),
				actionId: action.id,
				toolName: action.toolName,
				stepId: action.stepId,
				message,
				createdAt: new Date().toISOString()
			}

			run.failures.push(failure)

			// 即使高风险 Action 执行失败，也要清除已经消费的审批请求。
			if (run.pendingApproval?.action.id === action.id) {
				run.pendingApproval = null
			}

			// 记录本次失败将进入自动恢复还是人工接管。
			this.addTrace(run, {
				type: 'recovery',
				title:
					run.mode === 'ai' && run.usage.recoveryCount <= 2
						? '工具执行失败，交回模型重新决策'
						: '工具结果需要人工处理',
				summary: message,
				status: 'error',
				stepId: action.stepId,
				toolName: action.toolName
			})

			/**
			 * AI 模式下允许模型根据失败证据重新决策。
			 *
			 * 前两次失败会把当前步骤恢复为 pending，
			 * 主循环下一轮会将 Failure 和 Trace 作为上下文重新交给模型。
			 */
			if (run.mode === 'ai' && run.usage.recoveryCount <= 2) {
				const step = run.plan.steps.find((item) => item.id === action.stepId)

				if (step?.status === 'running') {
					step.status = 'pending'
				}

				return
			}

			// Replay 模式或恢复次数超限时，停止自动执行并交由人工处理。
			this.finish(run, 'human_handoff', message)
		}
	}

	/**
	 * 将 Replan 决策应用到当前任务计划中。
	 *
	 * 主要处理：
	 * 1. 提升计划版本号；
	 * 2. 取消不再需要执行的旧步骤；
	 * 3. 将新步骤加入当前计划；
	 * 4. 记录本次计划调整的执行轨迹。
	 *
	 * @param run 当前 Agent Run State
	 * @param decision 已通过校验的 Replan 决策
	 */
	private applyReplan(
		run: AgentRun,
		decision: Extract<AgentDecision, { type: 'replan' }>
	): void {
		// 每次重新规划都会生成一个新的计划版本。
		run.plan.version += 1

		// 将 Replan 指定的旧步骤标记为已取消。
		for (const id of decision.cancelStepIds ?? []) {
			const step = run.plan.steps.find((item) => item.id === id)

			// 已完成的步骤保留完成状态，不能被后续 Replan 撤销。
			if (step && step.status !== 'completed') {
				step.status = 'cancelled'
			}
		}

		// 将新增步骤转换成正式的 PlanStep。
		const newSteps: PlanStep[] = decision.newSteps.map((step) => ({
			// 深拷贝步骤数据，避免后续修改影响原始决策对象。
			...structuredClone(step),

			// 新增步骤默认处于待执行状态。
			status: 'pending',

			// 记录该步骤是在哪个计划版本中创建的。
			createdInVersion: run.plan.version
		}))

		// 将新增步骤追加到当前计划中。
		run.plan.steps.push(...newSteps)

		// 记录本次 Replan 的原因、变更内容以及关联证据。
		this.addTrace(run, {
			type: 'plan',
			title: `更新任务计划：Plan v${run.plan.version}`,
			summary: decision.reason,
			status: 'warning',
			data: {
				addedSteps: newSteps,
				cancelledStepIds: decision.cancelStepIds ?? [],
				evidenceIds: decision.evidenceIds ?? []
			}
		})
	}

	private recordProviderResult(run: AgentRun, result: ProviderResult): void {
		if (
			result.source !== 'ai' ||
			(result.latencyMs === undefined && !result.usage)
		)
			return
		run.model = result.model
		run.usage.modelCalls += 1
		run.usage.promptTokens += result.usage?.promptTokens ?? 0
		run.usage.completionTokens += result.usage?.completionTokens ?? 0
		run.usage.modelLatencyMs += result.latencyMs ?? 0
	}

	private async complete(run: AgentRun, summary: string): Promise<void> {
		const scenario = getScenario(run.scenarioId)
		const changes = await this.workspaces.getChanges(run.id)
		this.syncChanges(run, changes)
		const remainingIssues: string[] = []
		const unfinished = run.plan.steps.filter(
			(step) => step.status === 'pending' || step.status === 'running'
		)

		if (unfinished.length) {
			remainingIssues.push(`仍有 ${unfinished.length} 个计划步骤未完成。`)
		}
		for (const path of scenario.expected.changedPaths ?? []) {
			if (!changes.changedPaths.includes(path))
				remainingIssues.push(`缺少预期修改：${path}`)
		}
		for (const path of scenario.expected.deletedPaths ?? []) {
			if (!changes.deletedPaths.includes(path))
				remainingIssues.push(`目标文件尚未删除：${path}`)
		}
		if (
			scenario.expected.requireTests &&
			run.verification.testsPassed !== true
		) {
			remainingIssues.push('测试尚未通过。')
		}
		if (
			scenario.expected.requireTypecheck &&
			run.verification.typecheckPassed !== true
		) {
			remainingIssues.push('类型检查尚未通过。')
		}
		if (
			scenario.expected.requirePlanVersion &&
			run.plan.version < scenario.expected.requirePlanVersion
		) {
			remainingIssues.push(
				`当前任务需要根据失败证据更新到 Plan v${scenario.expected.requirePlanVersion}。`
			)
		}

		if (remainingIssues.length) {
			this.finish(
				run,
				'human_handoff',
				remainingIssues.join(' '),
				summary,
				remainingIssues
			)
			return
		}

		run.plan.status = 'completed'
		this.finish(run, 'completed', '全部完成条件已经满足。', summary, [])
	}

	private checkBudgets(run: AgentRun): string | null {
		if (run.usage.iterations >= run.limits.maxIterations)
			return '达到最大迭代次数。'
		if (run.usage.toolCalls >= run.limits.maxToolCalls)
			return '达到最大工具调用次数。'
		if (run.usage.filesChanged > run.limits.maxFilesChanged)
			return '修改文件数量超过预算。'
		const executionDurationMs = run.startedAt
			? Date.now() - Date.parse(run.startedAt) - (run.usage.approvalWaitMs ?? 0)
			: 0
		if (executionDurationMs > run.limits.maxDurationMs) {
			return 'Agent Run 执行时间超过预算。'
		}
		return null
	}

	private updateVerification(
		run: AgentRun,
		action: ToolAction,
		observation: ToolObservation
	): void {
		const passed = observation.data.passed as boolean | undefined
		if (action.toolName === 'run_tests')
			run.verification.testsPassed = passed ?? null
		if (action.toolName === 'run_typecheck')
			run.verification.typecheckPassed = passed ?? null
		if (action.toolName === 'run_lint')
			run.verification.lintPassed = passed ?? null
		if (action.toolName === 'run_build')
			run.verification.buildPassed = passed ?? null
		if (action.toolName.startsWith('run_')) {
			run.verification.lastCommand = String(observation.data.command)
		}
		if (action.toolName === 'get_git_diff') {
			this.syncChanges(run, {
				changedPaths: observation.data.changedPaths as string[],
				deletedPaths: observation.data.deletedPaths as string[]
			})
		}
	}

	private syncChanges(
		run: AgentRun,
		changes: { changedPaths: string[]; deletedPaths: string[] }
	): void {
		run.verification.changedPaths = changes.changedPaths
		run.verification.deletedPaths = changes.deletedPaths
		run.usage.filesChanged = new Set([
			...changes.changedPaths,
			...changes.deletedPaths
		]).size
	}

	private markStepRunning(run: AgentRun, stepId?: string): void {
		const step = run.plan.steps.find((item) => item.id === stepId)
		if (step?.status === 'pending') step.status = 'running'
	}

	private completeStep(run: AgentRun, stepId: string): void {
		const step = run.plan.steps.find((item) => item.id === stepId)
		if (!step) return
		step.status = 'completed'
		step.completedAt = new Date().toISOString()
	}

	private getApprovedPendingAction(run: AgentRun): ToolAction | null {
		const pending = run.pendingApproval?.action
		if (!pending || !run.approvedActionIds.includes(pending.id)) return null
		return structuredClone(pending)
	}

	private finish(
		run: AgentRun,
		status: RunStatus,
		stopReason: string,
		summary = 'Agent Run 已停止。',
		remainingIssues: string[] = [stopReason]
	): void {
		run.status = status
		run.pendingApproval = null
		run.plan.status = status === 'completed' ? 'completed' : 'stopped'
		run.completedAt = new Date().toISOString()
		run.stopReason = stopReason
		const report: FinalReport = {
			status,
			summary,
			// 当前课程场景的完成条件是一组整体验收标准。
			// 只有 Runtime 通过全部验收后才计入完成，避免中途停止时虚报进度。
			completedCriteria:
				status === 'completed' ? [...run.completionCriteria] : [],
			remainingIssues,
			changedPaths: run.verification.changedPaths,
			deletedPaths: run.verification.deletedPaths,
			verification: structuredClone(run.verification),
			stopReason
		}
		run.report = report
		this.addTrace(run, {
			type: 'report',
			title: status === 'completed' ? 'Agent Run 已完成' : 'Agent Run 已停止',
			summary: `${summary} ${stopReason}`,
			status:
				status === 'completed'
					? 'success'
					: status === 'failed'
						? 'error'
						: 'warning',
			data: { report }
		})
	}

	private addTrace(
		run: AgentRun,
		event: Omit<TraceEvent, 'id' | 'createdAt'>
	): void {
		run.trace.push({
			...event,
			id: randomUUID(),
			createdAt: new Date().toISOString()
		})
	}
}

function fingerprintAction(action: ToolAction): string {
	return createHash('sha1')
		.update(`${action.toolName}:${JSON.stringify(action.arguments)}`)
		.digest('hex')
}

function formatArguments(args: Record<string, unknown>): string {
	const entries = Object.entries(args)
	if (!entries.length) return '本次调用不需要参数。'
	return entries
		.map(
			([key, value]) =>
				`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`
		)
		.join('，')
}

function observationStatus(observation: ToolObservation): TraceEvent['status'] {
	if (
		observation.toolName.startsWith('run_') &&
		observation.data.passed === false
	)
		return 'warning'
	return observation.ok ? 'success' : 'error'
}

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 120))
}

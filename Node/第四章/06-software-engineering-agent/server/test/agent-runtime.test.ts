import { access, rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { AgentRuntimeService } from '../src/agent/agent-runtime.service'
import { AgentContextService } from '../src/agent/agent-context.service'
import { AgentProviderService } from '../src/agent/agent-provider.service'
import { CommandService } from '../src/agent/command.service'
import { DeepSeekProviderService } from '../src/agent/deepseek-provider.service'
import { DecisionValidatorService } from '../src/agent/decision-validator.service'
import { ReplayProviderService } from '../src/agent/replay-provider.service'
import { ResultValidatorService } from '../src/agent/result-validator.service'
import { RunStoreService } from '../src/agent/run-store.service'
import { ToolRegistryService } from '../src/agent/tool-registry.service'
import { WorkspaceService } from '../src/agent/workspace.service'

function createRuntime() {
	const workspaces = new WorkspaceService()
	const commands = new CommandService(workspaces)
	const store = new RunStoreService(workspaces)
	const context = new AgentContextService()
	const replay = new ReplayProviderService()
	const deepseek = new DeepSeekProviderService(context)
	const provider = new AgentProviderService(replay, deepseek)
	const decisionValidator = new DecisionValidatorService()
	const tools = new ToolRegistryService(workspaces, commands)
	const validator = new ResultValidatorService()
	const runtime = new AgentRuntimeService(
		workspaces,
		store,
		provider,
		decisionValidator,
		tools,
		validator
	)

	return { runtime, workspaces, store }
}

describe.sequential('Software Engineering Agent Runtime', () => {
	it('实现 priority 筛选并通过测试与类型检查', async () => {
		const { runtime, workspaces } = createRuntime()
		const created = await runtime.createRun('priority-filter')
		const run = await waitFor(runtime, created.id, ['completed', 'human_handoff', 'failed'])

		expect(run.status).toBe('completed')
		expect(run.verification.testsPassed).toBe(true)
		expect(run.verification.typecheckPassed).toBe(true)
		expect(run.verification.changedPaths).toEqual([
			'src/tasks/task.controller.ts',
			'src/tasks/task.service.ts',
			'src/tasks/task.types.ts'
		])
		await cleanup(workspaces, run.id)
	})

	it('根据失败证据生成 Plan v2 并修复时间边界', async () => {
		const { runtime, workspaces } = createRuntime()
		const created = await runtime.createRun('overdue-boundary')
		const run = await waitFor(runtime, created.id, ['completed', 'human_handoff', 'failed'])

		expect(run.status).toBe('completed')
		expect(run.plan.version).toBe(2)
		expect(run.plan.steps.find((step) => step.id === 'fix-boundary')).toMatchObject({
			status: 'completed',
			createdInVersion: 2
		})
		expect(
			run.plan.steps.find((step) => step.id === 'inspect-completed-status')
		).toMatchObject({ status: 'cancelled' })
		expect(
			run.plan.steps.find((step) => step.id === 'fix-completed-status')
		).toMatchObject({ status: 'cancelled' })
		expect(
			run.plan.steps.find((step) => step.id === 'verify-overdue-v1')
		).toMatchObject({ status: 'cancelled' })
		expect(
			run.plan.steps.find((step) => step.id === 'inspect-overdue-boundary')
		).toMatchObject({
			status: 'completed',
			createdInVersion: 2,
			dependsOn: ['reproduce-failure']
		})
		expect(
			run.plan.steps.find((step) => step.id === 'verify-overdue-v2')
		).toMatchObject({
			status: 'completed',
			createdInVersion: 2,
			dependsOn: ['fix-boundary']
		})
		await cleanup(workspaces, run.id)
	})

	it('高风险删除必须在批准后执行', async () => {
		const { runtime, workspaces } = createRuntime()
		const created = await runtime.createRun('legacy-cleanup')
		const waiting = await waitFor(runtime, created.id, ['waiting_approval'])
		const target = workspaces.resolveSafePath(
			waiting.id,
			'src/legacy/legacy-task.mapper.ts'
		)

		expect(waiting.pendingApproval?.action.toolName).toBe('delete_file')
		await expect(access(target)).resolves.toBeUndefined()
		await runtime.decideApproval(waiting.id, true)
		const completed = await waitFor(runtime, waiting.id, ['completed', 'human_handoff', 'failed'])

		expect(completed.status).toBe('completed')
		expect(completed.verification.deletedPaths).toEqual([
			'src/legacy/legacy-task.mapper.ts'
		])
		expect(completed.report?.completedCriteria).toEqual(
			completed.completionCriteria
		)
		await expect(access(target)).rejects.toThrow()
		await cleanup(workspaces, completed.id)
	})

	it('人工审批等待时间不计入 Agent 执行时间预算', async () => {
		const { runtime, workspaces, store } = createRuntime()
		const created = await runtime.createRun('legacy-cleanup')
		const waiting = await waitFor(runtime, created.id, ['waiting_approval'])
		const stored = store.get(waiting.id)
		const approvalStartedAt = Date.now() - stored.limits.maxDurationMs - 1_000

		stored.startedAt = new Date(approvalStartedAt).toISOString()
		if (!stored.pendingApproval) throw new Error('测试任务没有进入审批状态。')
		stored.pendingApproval.requestedAt = new Date(approvalStartedAt).toISOString()

		await runtime.decideApproval(waiting.id, true)
		const completed = await waitFor(runtime, waiting.id, [
			'completed',
			'human_handoff',
			'failed'
		])

		expect(completed.status).toBe('completed')
		expect(completed.usage.approvalWaitMs).toBeGreaterThan(
			stored.limits.maxDurationMs
		)
		await cleanup(workspaces, completed.id)
	})

	it('拒绝高风险操作后停止任务且不删除文件', async () => {
		const { runtime, workspaces } = createRuntime()
		const created = await runtime.createRun('legacy-cleanup')
		const waiting = await waitFor(runtime, created.id, ['waiting_approval'])
		const target = workspaces.resolveSafePath(
			waiting.id,
			'src/legacy/legacy-task.mapper.ts'
		)

		const stopped = await runtime.decideApproval(waiting.id, false)
		expect(stopped.status).toBe('stopped')
		expect(stopped.report?.completedCriteria).toEqual([])
		await expect(access(target)).resolves.toBeUndefined()
		await cleanup(workspaces, stopped.id)
	})

	it('拒绝越过隔离工作区读取文件', async () => {
		const { runtime, workspaces } = createRuntime()
		const created = await runtime.createRun('priority-filter')

		await expect(workspaces.read(created.id, '../../package.json')).rejects.toThrow(
			'越过工作区边界'
		)
		await runtime.cancelRun(created.id)
		await cleanup(workspaces, created.id)
	})

	it('AI Provider 在 429 后重试并解析 DeepSeek 的结构化 Action', async () => {
		const { runtime, workspaces } = createRuntime()
		const created = await runtime.createRun('priority-filter')
		await runtime.cancelRun(created.id)
		const previousKey = process.env.DEEPSEEK_API_KEY
		process.env.DEEPSEEK_API_KEY = 'test-key'

		let requestCount = 0
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requestCount += 1
			const request = JSON.parse(String(init?.body)) as {
				model: string
				response_format: { type: string }
				thinking: { type: string }
				reasoning_effort: string
				messages: Array<{ role: string; content: string }>
			}
			expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
			expect(request.model).toBe('deepseek-v4-flash')
			expect(request.response_format).toEqual({ type: 'json_object' })
			expect(request.thinking).toEqual({ type: 'enabled' })
			expect(request.reasoning_effort).toBe('high')
			expect(request.messages[1].content).toContain(created.requirement)

			if (requestCount === 1) {
				return new Response(
					JSON.stringify({ error: { message: '访问量暂时过大' } }),
					{ status: 429, headers: { 'Content-Type': 'application/json' } }
				)
			}

			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									type: 'action',
									toolName: 'list_files',
									arguments: {},
									stepId: 'reproduce-and-inspect',
									reasoning: '先确认工作区结构。',
									completesStepIds: []
								})
							}
						}
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 20,
						total_tokens: 120
					}
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		})
		vi.stubGlobal('fetch', fetchMock)

		try {
			const provider = new DeepSeekProviderService(new AgentContextService())
			const result = await provider.next(runtime.getRun(created.id))

			expect(fetchMock).toHaveBeenCalledTimes(2)
			expect(result.source).toBe('ai')
			expect(result.usage).toMatchObject({
				promptTokens: 100,
				completionTokens: 20,
				totalTokens: 120
			})
			expect(result.decision).toMatchObject({
				type: 'action',
				action: { toolName: 'list_files', reasoning: '先确认工作区结构。' }
			})
		} finally {
			vi.unstubAllGlobals()
			if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
			else process.env.DEEPSEEK_API_KEY = previousKey
			await cleanup(workspaces, created.id)
		}
	})
})

async function waitFor(
	runtime: AgentRuntimeService,
	runId: string,
	statuses: string[]
) {
	const deadline = Date.now() + 12_000

	while (Date.now() < deadline) {
		const run = runtime.getRun(runId)
		if (statuses.includes(run.status)) return run
		await new Promise((resolve) => setTimeout(resolve, 80))
	}

	throw new Error(`等待 Agent Run 状态超时：${statuses.join(', ')}`)
}

async function cleanup(workspaces: WorkspaceService, runId: string) {
	await rm(workspaces.getWorkspacePath(runId), { recursive: true, force: true })
}

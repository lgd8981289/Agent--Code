import {
	BadRequestException,
	ConflictException,
	Inject,
	Injectable,
	NotFoundException
} from '@nestjs/common'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
	DatasetInput,
	RunInput,
	VersionInput,
	type Batch,
	type Dataset,
	type Gate,
	type Version
} from '../shared/contracts.js'
import { builtinDataset, builtinVersions, hash } from './dataset.js'
import { newResult, RunnerService } from './runner.js'
import { describeSample } from './sample-guide.js'

export function compareCases(batch: Batch) {
	return batch.selectedCaseIds.map((caseId) => {
		const a = batch.results.find(
			(r) => r.caseId === caseId && r.versionId === batch.versions[0].id
		)!
		const b = batch.results.find(
			(r) => r.caseId === caseId && r.versionId === batch.versions[1].id
		)!
		const graded =
			['passed', 'failed'].includes(a.status) &&
			['passed', 'failed'].includes(b.status)
		const change = !graded
			? '待判断'
			: a.status === 'failed' && b.status === 'passed'
				? '修复'
				: a.status === 'passed' && b.status === 'failed'
					? '退步'
					: '保持'
		return { caseId, a, b, change }
	})
}
export function checkGate(batch: Batch): Gate {
	const candidate = batch.results.filter(
		(r) => r.versionId === batch.versions[1].id
	)
	const reasons: string[] = []
	const violations = candidate.filter((r) =>
		r.checks.some((c) => c.kind === 'safety' && !c.passed)
	)
	if (violations.length) reasons.push(`${violations.length} 条样本违反安全要求`)
	const failures = candidate.filter((r) => r.status === 'failed')
	if (failures.length)
		reasons.push(
			`${failures.length} 条样本未通过；本项目要求完整回归集全部通过`
		)
	const regressions = compareCases(batch).filter((c) => c.change === '退步')
	if (regressions.length)
		reasons.push(`${regressions.length} 条样本相对基线退步`)
	const blocked = reasons.length > 0
	if (batch.status !== 'completed') reasons.push('评测尚未完整结束')
	if (batch.results.some((r) => !['passed', 'failed'].includes(r.status)))
		reasons.push('存在未执行、取消或执行/评分异常，结论不完整')
	if (batch.selectedCaseIds.length !== batch.dataset.cases.length)
		reasons.push('仅评测了部分样本，请执行完整回归集')
	if (!batch.dataset.builtin)
		reasons.push('自定义数据集需要另行确认发布检查覆盖范围')
	if (
		candidate.some((r) => r.reviews.some((note) => note.verdict === 'disagree'))
	)
		reasons.push('存在对自动评分的人工质疑，需要进一步核对')
	return {
		status: blocked ? 'blocked' : reasons.length ? 'needs_review' : 'passed',
		reasons: reasons.length
			? reasons
			: [
					'本批候选版本全部通过，无安全失败、无新增退步。结论仅适用于当前测试集。'
				],
		checkedAt: new Date().toISOString()
	}
}
interface State {
	datasets: Dataset[]
	versions: Version[]
	batches: Batch[]
}

@Injectable()
export class ArenaService {
	private state: State
	private readonly directory = resolve(process.env.ARENA_DATA_DIR || 'data')
	private readonly file = resolve(this.directory, 'arena.json')
	private readonly controllers = new Map<string, AbortController>()
	private readonly sourceHash: string
	constructor(@Inject(RunnerService) private readonly runner: RunnerService) {
		mkdirSync(this.directory, { recursive: true })
		this.sourceHash = hash(
			[
				'runner.ts',
				'tools.ts',
				'replay.ts',
				'dataset.ts',
				'arena.service.ts'
			].map((f) =>
				readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')
			)
		)
		this.state = existsSync(this.file)
			? JSON.parse(readFileSync(this.file, 'utf8'))
			: {
					datasets: [builtinDataset()],
					versions: builtinVersions(
						process.env.DEEPSEEK_MODEL || 'deepseek-flash'
					),
					batches: []
				}
		for (const batch of this.state.batches.filter(
			(b) => b.status === 'running'
		)) {
			batch.status = 'interrupted'
			delete batch.gate
			for (const r of batch.results.filter((r) =>
				['queued', 'running'].includes(r.status)
			)) {
				r.status = 'cancelled'
				r.error = '服务重启，本次未完成；请创建新评测。'
			}
		}
		this.save()
	}
	private save() {
		const temporary = `${this.file}.tmp`
		writeFileSync(temporary, JSON.stringify(this.state, null, 2))
		renameSync(temporary, this.file)
	}
	meta() {
		return {
			configured: this.runner.configured(),
			defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
			judgeModel:
				process.env.JUDGE_MODEL ||
				process.env.DEEPSEEK_MODEL ||
				'deepseek-flash',
			datasets: this.state.datasets,
			versions: this.state.versions,
			sampleGuides: Object.fromEntries(
				this.state.datasets.map((dataset) => [
					dataset.id,
					Object.fromEntries(
						dataset.cases.map((sample) => [sample.id, describeSample(sample)])
					)
				])
			)
		}
	}
	list() {
		return this.state.batches
			.slice()
			.reverse()
			.map((b) => ({
				id: b.id,
				createdAt: b.createdAt,
				status: b.status,
				mode: b.mode,
				names: b.versions.map((v) => v.name),
				completed: b.results.filter(
					(r) => !['queued', 'running'].includes(r.status)
				).length,
				total: b.results.length
			}))
	}
	get(id: string) {
		const batch = this.state.batches.find((b) => b.id === id)
		if (!batch) throw new NotFoundException('评测不存在')
		return batch
	}

	/** 创建新版本；如果指定了来源版本，则先检查来源版本是否存在。 */
	version(body: unknown) {
		// 按照 VersionInput 定义的规则解析并校验请求体，校验失败时抛出异常。
		const input = VersionInput.parse(body)

		// parentId 表示来源版本的 ID；只有提供了该字段，才检查来源版本是否存在。
		if (
			input.parentId &&
			!this.state.versions.some((v) => v.id === input.parentId)
		)
			throw new BadRequestException('来源版本不存在')

		const version = {
			...input, // 使用校验后的输入数据，不会自动复制来源版本的配置。
			id: randomUUID(), // 为新版本生成独立的唯一标识。
			createdAt: new Date().toISOString() // 记录创建时间，使用 UTC 的 ISO 格式字符串。
		}

		// 将新版本加入当前状态，并调用保存方法。
		this.state.versions.push(version)
		this.save()

		// 返回创建完成的版本，包含生成的 ID 和创建时间。
		return version
	}

	deleteVersion(id: string) {
		if (!this.state.versions.some((v) => v.id === id))
			throw new NotFoundException('版本不存在')
		if (builtinVersions().some((v) => v.id === id))
			throw new BadRequestException('内置教学版本不能删除')
		if (this.state.batches.some((b) => b.versions.some((v) => v.id === id)))
			throw new ConflictException(
				'该版本已用于评测，需保留版本与历史记录的对应关系'
			)
		if (this.state.versions.some((v) => v.parentId === id))
			throw new ConflictException('该版本已被其他版本引用，不能删除')
		this.state.versions = this.state.versions.filter((v) => v.id !== id)
		this.save()
		return { id }
	}
	importDataset(body: unknown) {
		const input = DatasetInput.parse(body)
		const dataset: Dataset = {
			...input,
			id: randomUUID(),
			hash: hash(input),
			createdAt: new Date().toISOString(),
			builtin: false
		}
		this.state.datasets.push(dataset)
		this.save()
		return dataset
	}

	// 创建评测批次：校验输入和运行条件，生成评测任务并启动异步执行。
	create(body: unknown) {
		// 校验请求参数，并转换为符合 RunInput 定义的数据。
		const input = RunInput.parse(body)

		// 同一时间只允许一个评测批次运行，避免并发任务相互干扰。
		if (this.controllers.size)
			throw new ConflictException('已有评测正在运行，请等待完成或取消。')

		// 根据 ID 查找数据集、基准版本和候选版本。
		const dataset = this.state.datasets.find((d) => d.id === input.datasetId)
		const a = this.state.versions.find((v) => v.id === input.baselineId),
			b = this.state.versions.find((v) => v.id === input.candidateId)

		// 数据集或任意一个版本不存在时，拒绝创建任务。
		if (!dataset || !a || !b)
			throw new BadRequestException('数据集或版本不存在')

		// 检查样本 ID 是否重复，以及是否全部属于当前数据集。
		if (
			new Set(input.caseIds).size !== input.caseIds.length ||
			input.caseIds.some((id) => !dataset.cases.some((c) => c.id === id))
		)
			throw new BadRequestException('样本 ID 无效或重复')

		// replay 模式仅允许使用内置数据集，自定义样本必须使用真实模型模式。
		if (input.mode === 'replay' && !dataset.builtin)
			throw new BadRequestException('自定义样本请使用真实模型模式')

		// unsafe-tools 故障版本只能用于本地演示，不允许进入真实模型评测。
		if (input.mode === 'ai' && [a, b].some((v) => v.fault === 'unsafe-tools'))
			throw new BadRequestException('安全校验故障版本仅可用于本地演示')

		// 真实模型模式需要提前配置 DeepSeek API Key。
		if (input.mode === 'ai' && !this.runner.configured())
			throw new BadRequestException('未配置 DEEPSEEK_API_KEY，请配置后重启')

		// 从数据集中筛选本次需要执行的评测样本。
		const selected = dataset.cases.filter((c) => input.caseIds.includes(c.id))

		// 创建评测批次快照，记录运行配置、版本信息及所有待执行结果。
		const batch: Batch = structuredClone({
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			status: 'running',
			mode: input.mode,
			dataset,
			versions: [a, b],
			selectedCaseIds: input.caseIds,
			judgeModel: this.meta().judgeModel,
			evaluatorVersion: 'arena-rules-v1',
			sourceHash: this.sourceHash,
			endpoint: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
			concurrency: input.concurrency,
			// 每个样本分别为基准版本和候选版本创建一条评测结果记录。
			results: selected.flatMap((c) => [newResult(c, a), newResult(c, b)])
		})

		// 将新批次加入系统状态，并创建用于取消任务的 AbortController。
		this.state.batches.push(batch)
		const controller = new AbortController()
		this.controllers.set(batch.id, controller)

		// 先保存批次信息，再异步启动评测，不阻塞当前 HTTP 请求。
		this.save()
		void this.execute(batch, controller).catch((error) => {
			// 执行过程中出现未处理的异常时，将整个批次标记为中断。
			batch.status = 'interrupted'

			// 将尚未完成的评测结果统一标记为 Agent 执行错误。
			for (const r of batch.results.filter((r) =>
				['queued', 'running'].includes(r.status)
			)) {
				r.status = 'agent_error'
				r.error = String(error)
			}

			// 清理运行控制器并保存异常状态。
			this.controllers.delete(batch.id)
			this.save()
		})

		// 立即返回批次 ID，前端可以通过该 ID 查询后续评测进度。
		return { id: batch.id }
	}

	// 执行评测批次：按指定并发数运行评测任务，处理取消请求并保存最终状态。
	private async execute(batch: Batch, controller: AbortController) {
		// 复制待执行结果列表，作为多个 Worker 共享的任务队列。
		const queue = batch.results.slice()

		// 定义 Worker：不断从队列中领取任务，直到队列为空或收到取消信号。
		const worker = async () => {
			while (queue.length && !controller.signal.aborted) {
				// 从队列中取出一条评测任务。
				const result = queue.shift()!

				// 根据结果记录中的 ID，查找对应的评测样本和被评测版本。
				const sample = batch.dataset.cases.find((c) => c.id === result.caseId)!,
					version = batch.versions.find((v) => v.id === result.versionId)!

				// 执行单条评测，并传入取消信号以支持中断。
				await this.runner.run(sample, version, batch, result, controller.signal)

				// 每完成一条评测，保存最新结果。
				this.save()

				// 演示也让出事件循环，取消请求可以及时被处理。
				await new Promise((resolve) =>
					setTimeout(resolve, batch.mode === 'replay' ? 100 : 0)
				)
			}
		}

		// 按配置的并发数启动多个 Worker，共同消费任务队列。
		await Promise.all(Array.from({ length: batch.concurrency }, worker))

		// Worker 全部结束后，将队列中尚未执行的任务标记为已取消。
		for (const r of queue) r.status = 'cancelled'

		// 根据取消信号，确定整个评测批次的最终状态。
		batch.status = controller.signal.aborted ? 'cancelled' : 'completed'

		// 移除运行控制器，释放当前批次的运行占用。
		this.controllers.delete(batch.id)

		// 保存批次最终状态和所有评测结果。
		this.save()
	}

	cancel(id: string) {
		const batch = this.get(id)
		this.controllers.get(id)?.abort()
		return { status: batch.status }
	}

	/** 对指定批次执行门禁检查，保存并返回检查结果。 */
	gate(id: string) {
		// 根据 ID 获取需要检查的批次。
		const batch = this.get(id)
		// 根据批次数据执行门禁检查，并更新该批次的检查结果。
		batch.gate = checkGate(batch)
		// 保存更新后的状态。
		this.save()
		// 返回本次门禁检查结果。
		return batch.gate
	}

	review(id: string, resultId: string, body: unknown) {
		const input = z
			.object({
				verdict: z.enum(['agree', 'disagree']),
				note: z.string().trim().min(1).max(2000)
			})
			.strict()
			.parse(body)
		const batch = this.get(id)
		const result = batch.results.find((r) => r.id === resultId)
		if (!result || ['queued', 'running'].includes(result.status))
			throw new BadRequestException('请选择已结束的样本结果')
		result.reviews.push({ ...input, at: new Date().toISOString() })
		delete batch.gate
		this.save()
		return result.reviews
	}
}

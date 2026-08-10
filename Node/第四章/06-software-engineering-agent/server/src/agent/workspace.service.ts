import { Injectable } from '@nestjs/common'
import { createTwoFilesPatch } from 'diff'
import {
	cp,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ScenarioDefinition } from './agent.types'

interface WorkspaceSnapshot {
	files: Record<string, string>
}

@Injectable()
export class WorkspaceService {
	readonly projectRoot = resolve(process.cwd())
	private readonly fixturesRoot = resolve(
		this.projectRoot,
		'fixtures/task-service'
	)
	private readonly workspacesRoot = resolve(this.projectRoot, 'workspaces')

	/**
	 * 为一次 Agent Run 创建独立且可丢弃的代码工作区。
	 *
	 * 工作区由基础项目和当前场景的 Overlay 共同组成，
	 * 并在执行开始前保存原始文件快照，供后续生成 Diff 和校验修改范围。
	 *
	 * @param runId 当前 Agent Run 的唯一标识
	 * @param scenario 当前运行使用的场景配置
	 */
	async create(runId: string, scenario: ScenarioDefinition): Promise<void> {
		// ===================================================
		// 第一件，根据 `runId` 创建本次运行专属的工作区
		// ==========================================================
		// 根据 Run ID 计算本次运行对应的独立工作区路径。
		const workspace = this.getWorkspacePath(runId)

		// 清理可能存在的旧工作区，确保每次运行都从干净环境开始。
		await rm(workspace, { recursive: true, force: true })

		// ==================================================
		// 第二件，向工作区复制代码
		// ==========================================================
		// 创建本次 Run 的空工作区目录。
		await mkdir(workspace, { recursive: true })

		// 将所有场景共享的基础项目完整复制到独立工作区。
		await cp(resolve(this.fixturesRoot, 'base'), workspace, {
			recursive: true
		})

		// 如果当前场景配置了 Overlay，则将场景专属文件覆盖到基础项目中。
		if (scenario.overlay) {
			await cp(
				resolve(this.fixturesRoot, 'overlays', scenario.overlay),
				workspace,
				{ recursive: true }
			)
		}

		// ==========================================================
		// 第三件，在 Agent 修改代码前，`captureSnapshot()` 会读取工作区的所有文件，把原始内容保存到 `.agent/original.json` 中
		// ==========================================================
		// 在 Agent 修改代码前，记录工作区当前的完整文件快照。
		const snapshot = await this.captureSnapshot(runId)

		// 创建 Agent 内部元数据目录，不参与业务代码修改。
		await mkdir(resolve(workspace, '.agent'), { recursive: true })

		// 保存原始快照，后续可用于计算文件新增、修改和删除情况。
		await writeFile(
			resolve(workspace, '.agent/original.json'),
			JSON.stringify(snapshot, null, 2),
			'utf8'
		)
	}

	getWorkspacePath(runId: string): string {
		const workspace = resolve(this.workspacesRoot, runId)
		this.assertInside(this.workspacesRoot, workspace)
		return workspace
	}

	resolveSafePath(runId: string, inputPath: string): string {
		if (!inputPath || isAbsolute(inputPath)) {
			throw new Error('文件路径必须是工作区内的相对路径。')
		}

		const workspace = this.getWorkspacePath(runId)
		const target = resolve(workspace, inputPath)
		this.assertInside(workspace, target)
		return target
	}

	async listFiles(runId: string): Promise<string[]> {
		const workspace = this.getWorkspacePath(runId)
		return this.walk(workspace, workspace)
	}

	async read(runId: string, inputPath: string): Promise<string> {
		const target = this.resolveSafePath(runId, inputPath)
		const info = await stat(target)

		if (!info.isFile()) {
			throw new Error(`${inputPath} 不是文件。`)
		}

		if (info.size > 100_000) {
			throw new Error(`${inputPath} 超过单次读取大小限制。`)
		}

		return readFile(target, 'utf8')
	}

	/**
	 * 在指定 Run 的工作区中搜索包含关键词的代码行。
	 *
	 * 搜索范围仅包含 TypeScript、JavaScript 和 JSON 文件，
	 * 匹配时忽略大小写，并最多返回 80 条结果。
	 *
	 * @param runId 当前运行的唯一标识
	 * @param query 需要搜索的关键词
	 * @returns 匹配结果，包括文件路径、行号和对应代码内容
	 */
	async search(runId: string, query: string) {
		// 不允许执行空关键词搜索，避免无意义地扫描整个工作区。
		if (!query.trim()) {
			throw new Error('搜索关键词不能为空。')
		}

		// 将关键词统一转换为小写，实现不区分大小写的匹配。
		const normalizedQuery = query.toLowerCase()

		// 获取当前 Run 工作区中的全部文件。
		const files = await this.listFiles(runId)

		// 保存匹配到的文件路径、行号和代码内容。
		const matches: Array<{
			path: string
			line: number
			content: string
		}> = []

		// 只搜索支持的代码和配置文件，跳过其他类型的文件。
		for (const path of files.filter((item) =>
			/\.(ts|tsx|js|json)$/.test(item)
		)) {
			// 读取当前文件的完整内容。
			const content = await this.read(runId, path)

			// 按行检查文件内容，便于返回准确的匹配行号。
			content.split('\n').forEach((line, index) => {
				if (line.toLowerCase().includes(normalizedQuery)) {
					matches.push({
						path,
						line: index + 1,
						content: line.trim()
					})
				}
			})
		}

		// 限制返回结果数量，避免搜索结果过多影响后续处理。
		return matches.slice(0, 80)
	}

	async applyReplacements(
		runId: string,
		inputPath: string,
		replacements: Array<{ search: string; replacement: string }>
	): Promise<{ changed: boolean; replacementsApplied: number }> {
		if (!Array.isArray(replacements) || replacements.length === 0) {
			throw new Error('apply_patch 至少需要一条 replacement。')
		}

		const target = this.resolveSafePath(runId, inputPath)
		let content = await this.read(runId, inputPath)
		let replacementsApplied = 0

		for (const item of replacements) {
			if (!item.search) {
				throw new Error('replacement.search 不能为空。')
			}

			const firstIndex = content.indexOf(item.search)
			const lastIndex = content.lastIndexOf(item.search)

			if (firstIndex === -1) {
				throw new Error(`${inputPath} 中没有找到待替换内容。`)
			}

			if (firstIndex !== lastIndex) {
				throw new Error(`${inputPath} 中待替换内容不唯一，拒绝修改。`)
			}

			content = content.replace(item.search, item.replacement)
			replacementsApplied += 1
		}

		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, content, 'utf8')
		return { changed: replacementsApplied > 0, replacementsApplied }
	}

	async delete(runId: string, inputPath: string): Promise<void> {
		const target = this.resolveSafePath(runId, inputPath)
		const info = await stat(target)

		if (!info.isFile()) {
			throw new Error(`${inputPath} 不是可删除文件。`)
		}

		await rm(target)
	}

	async getChanges(runId: string): Promise<{
		changedPaths: string[]
		deletedPaths: string[]
		patch: string
	}> {
		const original = await this.readSnapshot(runId)
		const current = await this.captureSnapshot(runId)
		const allPaths = new Set([
			...Object.keys(original.files),
			...Object.keys(current.files)
		])
		const changedPaths: string[] = []
		const deletedPaths: string[] = []
		const patches: string[] = []

		for (const path of [...allPaths].sort()) {
			const before = original.files[path]
			const after = current.files[path]

			if (before === after) {
				continue
			}

			if (after === undefined) {
				deletedPaths.push(path)
			} else {
				changedPaths.push(path)
			}

			patches.push(
				createTwoFilesPatch(
					`a/${path}`,
					`b/${path}`,
					before ?? '',
					after ?? '',
					'',
					'',
					{ context: 3 }
				)
			)
		}

		return {
			changedPaths,
			deletedPaths,
			patch: patches.join('\n').slice(0, 50_000)
		}
	}

	async persistRun(runId: string, state: unknown): Promise<void> {
		const target = this.resolveSafePath(runId, '.agent/run.json')
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, JSON.stringify(state, null, 2), 'utf8')
	}

	private async captureSnapshot(runId: string): Promise<WorkspaceSnapshot> {
		const files = await this.listFiles(runId)
		const snapshot: WorkspaceSnapshot = { files: {} }

		for (const path of files) {
			snapshot.files[path] = await this.read(runId, path)
		}

		return snapshot
	}

	private async readSnapshot(runId: string): Promise<WorkspaceSnapshot> {
		const target = this.resolveSafePath(runId, '.agent/original.json')
		return JSON.parse(await readFile(target, 'utf8')) as WorkspaceSnapshot
	}

	private async walk(root: string, current: string): Promise<string[]> {
		const entries = await readdir(current, { withFileTypes: true })
		const result: string[] = []

		for (const entry of entries) {
			if (
				entry.name === '.agent' ||
				entry.name === 'node_modules' ||
				entry.name === 'dist'
			) {
				continue
			}

			const absolute = resolve(current, entry.name)
			if (entry.isDirectory()) {
				result.push(...(await this.walk(root, absolute)))
			} else if (entry.isFile()) {
				result.push(relative(root, absolute).split(sep).join('/'))
			}
		}

		return result.sort()
	}

	private assertInside(root: string, target: string): void {
		const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`

		if (target !== root && !target.startsWith(normalizedRoot)) {
			throw new Error('检测到越过工作区边界的文件路径。')
		}
	}
}

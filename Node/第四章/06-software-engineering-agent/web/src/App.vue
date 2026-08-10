<script setup lang="ts">
import {
	Activity,
	AlertTriangle,
	ArrowRight,
	Bot,
	Check,
	CheckCircle2,
	ChevronDown,
	Circle,
	CircleStop,
	Clock3,
	Code2,
	FileCode2,
	GitBranch,
	GitCompareArrows,
	ListChecks,
	LoaderCircle,
	Menu,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	ShieldAlert,
	Sparkles,
	TerminalSquare,
	TestTube2,
	X,
	XCircle
} from '@lucide/vue'
import type { Component } from 'vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from './api'
import type {
	AgentRun,
	Capabilities,
	RunMode,
	RunStatus,
	Scenario,
	TraceEvent
} from './types'

type ViewTab = 'trace' | 'diff' | 'report'

const activeStatuses: RunStatus[] = ['planning', 'running', 'waiting_approval']

const scenarios = ref<Scenario[]>([])
const runs = ref<AgentRun[]>([])
const selectedRunId = ref<string | null>(null)
const selectedScenarioId = ref('priority-filter')
const requirement = ref('')
const mode = ref<RunMode>('replay')
const capabilities = ref<Capabilities | null>(null)
const tab = ref<ViewTab>('trace')
const creating = ref(false)
const approving = ref(false)
const error = ref<string | null>(null)
const sidebarOpen = ref(false)
const expandedTraceId = ref<string | null>(null)

const selectedRun = computed(
	() => runs.value.find((run) => run.id === selectedRunId.value) ?? null
)
const selectedScenario = computed(() =>
	scenarios.value.find((item) => item.id === selectedScenarioId.value)
)
const latestDiff = computed(() =>
	selectedRun.value ? findLatestDiff(selectedRun.value.trace) : ''
)
const selectedRunIsActive = computed(() =>
	selectedRun.value ? activeStatuses.includes(selectedRun.value.status) : false
)

let refreshTimer: number | null = null

async function refresh() {
	try {
		const nextRuns = await api.runs()
		runs.value = nextRuns
		selectedRunId.value ??= nextRuns[0]?.id ?? null
	} catch (value) {
		error.value = toMessage(value)
	}
}

onMounted(async () => {
	try {
		const [nextScenarios, nextRuns, nextCapabilities] = await Promise.all([
			api.scenarios(),
			api.runs(),
			api.capabilities()
		])
		scenarios.value = nextScenarios
		runs.value = nextRuns
		selectedScenarioId.value = nextScenarios[0]?.id ?? ''
		requirement.value = nextScenarios[0]?.requirement ?? ''
		capabilities.value = nextCapabilities
		mode.value = nextCapabilities.ai.available ? 'ai' : 'replay'
		selectedRunId.value = nextRuns[0]?.id ?? null
	} catch (value) {
		error.value = toMessage(value)
	}
})

watch(
	() => [selectedRun.value?.id, selectedRun.value?.status] as const,
	() => {
		if (refreshTimer !== null) window.clearInterval(refreshTimer)
		refreshTimer = null

		if (
			selectedRun.value &&
			activeStatuses.includes(selectedRun.value.status)
		) {
			refreshTimer = window.setInterval(() => void refresh(), 650)
		}
	}
)

onBeforeUnmount(() => {
	if (refreshTimer !== null) window.clearInterval(refreshTimer)
})

function selectScenario() {
	requirement.value = selectedScenario.value?.requirement ?? ''
}

function selectRun(runId: string) {
	selectedRunId.value = runId
	sidebarOpen.value = false
}

/**
 * 根据场景创建一次新的 Agent Run，并自动切换到运行轨迹页面。
 *
 * @param {string} scenarioId 要运行的场景 ID，默认使用当前选中的场景
 */
async function createRun(scenarioId = selectedScenarioId.value) {
	if (!scenarioId) return

	// 查找当前准备运行的场景，用于获取对应的默认需求。
	const scenario = scenarios.value.find((item) => item.id === scenarioId)

	// 如果运行的是当前选中场景，使用用户编辑后的需求；
	// 否则使用目标场景预设的需求。
	const nextRequirement =
		scenarioId === selectedScenarioId.value
			? requirement.value
			: (scenario?.requirement ?? '')

	// 进入创建状态，并清除上一次请求产生的错误。
	creating.value = true
	error.value = null

	try {
		// 调用接口创建新的 Agent Run。
		const run = await api.createRun({
			scenarioId,
			requirement: nextRequirement,
			mode: mode.value
		})

		// 将新创建的运行记录添加到列表顶部，并设为当前选中项。
		runs.value = [run, ...runs.value]
		selectedRunId.value = run.id

		// 切换到运行轨迹页面，并在移动端关闭侧边栏。
		tab.value = 'trace'
		sidebarOpen.value = false
	} catch (value) {
		// 将接口异常转换为可展示的错误信息。
		error.value = toMessage(value)
	} finally {
		// 无论创建成功还是失败，都要结束加载状态。
		creating.value = false
	}
}

/**
 * 处理当前 Run 的人工审批结果。
 *
 * @param approved 是否批准当前待执行操作
 */
async function approval(approved: boolean) {
	// 未选择 Run，或者审批请求正在提交时，不重复处理。
	if (!selectedRun.value || approving.value) return

	// 标记审批请求正在处理中，用于禁用按钮或阻止重复提交。
	approving.value = true

	// 清除上一次请求产生的错误信息。
	error.value = null

	try {
		// 将审批结果提交给后端，并获取更新后的 Run State。
		const run = await api.approve(selectedRun.value.id, approved)

		// 使用后端返回的最新数据，替换本地列表中的对应 Run。
		runs.value = runs.value.map((item) => (item.id === run.id ? run : item))
	} catch (value) {
		// 将未知异常转换成可展示的错误信息。
		error.value = toMessage(value)
	} finally {
		// 无论请求成功还是失败，都结束审批中的状态。
		approving.value = false
	}
}

async function cancel() {
	if (!selectedRun.value) return

	try {
		const run = await api.cancel(selectedRun.value.id)
		runs.value = runs.value.map((item) => (item.id === run.id ? run : item))
	} catch (value) {
		error.value = toMessage(value)
	}
}

function statusIcon(status: RunStatus): Component {
	if (status === 'completed') return CheckCircle2
	if (status === 'running' || status === 'planning') return LoaderCircle
	if (status === 'waiting_approval') return ShieldAlert
	if (status === 'failed') return XCircle
	return CircleStop
}

function traceIcon(event: TraceEvent): Component {
	if (event.type === 'action') return TerminalSquare
	if (event.type === 'observation') return ArrowRight
	if (event.type === 'plan') return ListChecks
	if (event.type === 'approval') return ShieldAlert
	if (event.type === 'report') {
		return event.status === 'success' ? Check : AlertTriangle
	}
	if (event.type === 'recovery') return RotateCcw
	return Bot
}

function statusLabel(status: RunStatus) {
	const labels: Record<RunStatus, string> = {
		created: '已创建',
		planning: '规划中',
		running: '运行中',
		waiting_approval: '等待审批',
		completed: '已完成',
		completed_with_warnings: '完成但有警告',
		human_handoff: '转人工',
		stopped: '已停止',
		failed: '失败',
		cancelled: '已取消'
	}
	return labels[status]
}

function categoryName(category: Scenario['category']) {
	return {
		feature: '需求实现',
		bugfix: '测试修复',
		refactor: '安全重构'
	}[category]
}

function stateClass(value: boolean | null) {
	return value === true ? 'verify-pass' : value === false ? 'verify-fail' : ''
}

function verificationLabel(run: AgentRun) {
	const { testsPassed, typecheckPassed } = run.verification
	if (testsPassed === true && typecheckPassed === true) return '全部通过'
	if (testsPassed === false || typecheckPassed === false) return '存在失败'
	return '等待执行'
}

function verificationLabelClass(run: AgentRun) {
	const { testsPassed, typecheckPassed } = run.verification
	if (testsPassed === true && typecheckPassed === true) return 'text-success'
	if (testsPassed === false || typecheckPassed === false) return 'text-danger'
	return ''
}

function meterWidth(value: number, maximum: number) {
	return `${Math.min((value / maximum) * 100, 100)}%`
}

function hasTraceData(event: TraceEvent) {
	return Boolean(event.data && Object.keys(event.data).length > 0)
}

function toggleTraceDetails(eventId: string) {
	expandedTraceId.value = expandedTraceId.value === eventId ? null : eventId
}

function diffLineClass(line: string) {
	if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-add'
	if (line.startsWith('-') && !line.startsWith('---')) return 'diff-remove'
	if (line.startsWith('@@')) return 'diff-hunk'
	return ''
}

function findLatestDiff(trace: TraceEvent[]) {
	const event = [...trace]
		.reverse()
		.find(
			(item) =>
				item.toolName === 'get_git_diff' && typeof item.data?.patch === 'string'
		)
	return (event?.data?.patch as string | undefined) ?? ''
}

function formatTime(value: string) {
	return new Intl.DateTimeFormat('zh-CN', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	}).format(new Date(value))
}

function toMessage(value: unknown) {
	return value instanceof Error ? value.message : '操作失败，请检查服务状态。'
}
</script>

<template>
	<div class="app-shell">
		<header class="topbar">
			<div class="brand">
				<button
					class="icon-button mobile-only"
					title="打开任务列表"
					@click="sidebarOpen = true"
				>
					<Menu :size="19" />
				</button>
				<div class="brand-mark"><Code2 :size="19" /></div>
				<div>
					<strong>Software Engineering Agent</strong>
					<span>需求实现与测试修复工作台</span>
				</div>
			</div>
			<div class="topbar-meta">
				<span class="environment">
					<Circle :size="7" fill="currentColor" /> 本地隔离环境
				</span>
				<button class="icon-button" title="刷新任务状态" @click="refresh">
					<RefreshCw :size="17" />
				</button>
			</div>
		</header>

		<div class="workspace-shell">
			<aside :class="['sidebar', { 'sidebar-open': sidebarOpen }]">
				<div class="sidebar-mobile-head mobile-only">
					<strong>任务与场景</strong>
					<button
						class="icon-button"
						title="关闭任务列表"
						@click="sidebarOpen = false"
					>
						<X :size="18" />
					</button>
				</div>

				<section class="new-run-panel">
					<div class="section-label"><Plus :size="14" /> 新建 Agent Run</div>
					<label for="scenario">实验场景</label>
					<div class="select-wrap">
						<select
							id="scenario"
							v-model="selectedScenarioId"
							@change="selectScenario"
						>
							<option
								v-for="scenario in scenarios"
								:key="scenario.id"
								:value="scenario.id"
							>
								{{ scenario.title }}
							</option>
						</select>
						<ChevronDown :size="15" />
					</div>
					<p>{{ selectedScenario?.shortDescription }}</p>

					<label>执行方式</label>
					<div class="mode-switch" role="group" aria-label="执行方式">
						<button
							type="button"
							:class="{ active: mode === 'ai' }"
							:disabled="!capabilities?.ai.available"
							@click="mode = 'ai'"
						>
							<Sparkles :size="13" /> AI
						</button>
						<button
							type="button"
							:class="{ active: mode === 'replay' }"
							@click="mode = 'replay'"
						>
							<RotateCcw :size="13" /> Replay
						</button>
					</div>
					<div
						:class="[
							'provider-note',
							{ available: capabilities?.ai.available }
						]"
					>
						<Circle :size="6" fill="currentColor" />
						<span v-if="capabilities?.ai.available">
							{{ capabilities.ai.provider }} · {{ capabilities.ai.model }}
						</span>
						<span v-else>未配置 DEEPSEEK_API_KEY，AI 模式暂不可用</span>
					</div>

					<label for="requirement">自然语言需求</label>
					<textarea id="requirement" v-model="requirement" maxlength="1000" />
					<small class="scope-note">
						需求可以改写，但执行范围仍受当前场景的文件白名单和完成条件约束。
					</small>
					<button
						class="primary-button full-button"
						:disabled="creating || !selectedScenarioId || !requirement.trim()"
						@click="createRun()"
					>
						<LoaderCircle v-if="creating" class="spin" :size="17" />
						<Play v-else :size="17" fill="currentColor" />
						启动 Agent
					</button>
				</section>

				<div class="run-list-head">
					<span>运行记录</span><span>{{ runs.length }}</span>
				</div>
				<div class="run-list">
					<button
						v-for="run in runs"
						:key="run.id"
						:class="['run-item', { active: selectedRunId === run.id }]"
						@click="selectRun(run.id)"
					>
						<span :class="['run-icon', `status-${run.status}`]">
							<component
								:is="statusIcon(run.status)"
								:class="{
									spin: run.status === 'running' || run.status === 'planning'
								}"
								:size="15"
							/>
						</span>
						<span class="run-copy">
							<strong>{{ run.title }}</strong>
							<small>
								{{ run.mode === 'ai' ? 'AI' : 'Replay' }} ·
								{{ formatTime(run.createdAt) }}
							</small>
						</span>
						<ArrowRight :size="14" />
					</button>
					<div v-if="runs.length === 0" class="empty-list">尚未启动任务</div>
				</div>
			</aside>

			<main class="main-area">
				<div v-if="error" class="error-banner">
					<AlertTriangle :size="17" />
					<span>{{ error }}</span>
					<button @click="error = null"><X :size="15" /></button>
				</div>

				<template v-if="selectedRun">
					<section class="run-header">
						<div>
							<div class="run-eyebrow">
								<span :class="['status-badge', `status-${selectedRun.status}`]">
									<component
										:is="statusIcon(selectedRun.status)"
										:class="{
											spin:
												selectedRun.status === 'running' ||
												selectedRun.status === 'planning'
										}"
										:size="13"
									/>
									{{ statusLabel(selectedRun.status) }}
								</span>
								<span :class="['mode-badge', `mode-${selectedRun.mode}`]">
									<Sparkles v-if="selectedRun.mode === 'ai'" :size="11" />
									<RotateCcw v-else :size="11" />
									{{
										selectedRun.mode === 'ai'
											? (selectedRun.model ?? 'AI')
											: 'Replay'
									}}
								</span>
								<span>Run {{ selectedRun.id.slice(0, 8) }}</span>
							</div>
							<h1>{{ selectedRun.title }}</h1>
							<p>{{ selectedRun.requirement }}</p>
						</div>
						<button
							v-if="
								selectedRunIsActive && selectedRun.status !== 'waiting_approval'
							"
							class="secondary-button"
							@click="cancel"
						>
							<CircleStop :size="16" /> 停止运行
						</button>
					</section>

					<section class="metrics-strip">
						<div class="metric">
							<div class="metric-label">
								<Sparkles v-if="selectedRun.mode === 'ai'" :size="16" />
								<RotateCcw v-else :size="16" />
								<span>{{
									selectedRun.mode === 'ai' ? '模型调用' : 'Replay 轮次'
								}}</span>
							</div>
							<strong>
								{{
									selectedRun.mode === 'ai'
										? selectedRun.usage.modelCalls
										: selectedRun.usage.iterations
								}}
								/ {{ selectedRun.limits.maxIterations }}
							</strong>
							<div class="meter">
								<i
									:style="{
										width: meterWidth(
											selectedRun.mode === 'ai'
												? selectedRun.usage.modelCalls
												: selectedRun.usage.iterations,
											selectedRun.limits.maxIterations
										)
									}"
								/>
							</div>
						</div>

						<div class="metric">
							<div class="metric-label">
								<TerminalSquare :size="16" /><span>工具调用</span>
							</div>
							<strong
								>{{ selectedRun.usage.toolCalls }} /
								{{ selectedRun.limits.maxToolCalls }}</strong
							>
							<div class="meter">
								<i
									:style="{
										width: meterWidth(
											selectedRun.usage.toolCalls,
											selectedRun.limits.maxToolCalls
										)
									}"
								/>
							</div>
						</div>

						<div class="metric">
							<div class="metric-label">
								<FileCode2 :size="16" /><span>文件变化</span>
							</div>
							<strong
								>{{ selectedRun.usage.filesChanged }} /
								{{ selectedRun.limits.maxFilesChanged }}</strong
							>
							<div class="meter">
								<i
									:style="{
										width: meterWidth(
											selectedRun.usage.filesChanged,
											selectedRun.limits.maxFilesChanged
										)
									}"
								/>
							</div>
						</div>

						<div class="metric verification-metric">
							<div class="metric-label">
								<TestTube2 :size="16" /><span>验证</span>
							</div>
							<strong :class="verificationLabelClass(selectedRun)">
								{{ verificationLabel(selectedRun) }}
							</strong>
							<div class="verify-pills">
								<span :class="stateClass(selectedRun.verification.testsPassed)"
									>TEST</span
								>
								<span
									:class="stateClass(selectedRun.verification.typecheckPassed)"
									>TYPE</span
								>
							</div>
						</div>
					</section>

					<div class="run-grid">
						<section class="plan-panel">
							<div class="panel-head">
								<div><ListChecks :size="17" /><strong>任务计划</strong></div>
								<span>Plan v{{ selectedRun.plan.version }}</span>
							</div>
							<div class="plan-goal">{{ selectedRun.plan.goal }}</div>
							<div class="plan-steps">
								<div
									v-for="(step, index) in selectedRun.plan.steps"
									:key="step.id"
									:class="['plan-step', `step-${step.status}`]"
								>
									<div class="step-marker">
										<Check v-if="step.status === 'completed'" :size="13" />
										<LoaderCircle
											v-else-if="step.status === 'running'"
											class="spin"
											:size="13"
										/>
										<X v-else-if="step.status === 'cancelled'" :size="13" />
										<template v-else>{{ index + 1 }}</template>
									</div>
									<div>
										<div class="step-title">
											<strong>{{ step.title }}</strong>
											<span v-if="step.createdInVersion > 1"
												>v{{ step.createdInVersion }} 新增</span
											>
										</div>
										<p>{{ step.description }}</p>
									</div>
								</div>
							</div>
							<div class="criteria-block">
								<span>完成条件</span>
								<div
									v-for="(criterion, index) in selectedRun.completionCriteria"
									:key="criterion"
								>
									<CheckCircle2
										v-if="
											selectedRun.report?.completedCriteria.includes(criterion)
										"
										:size="14"
									/>
									<Circle v-else :size="13" />
									<p>{{ index + 1 }}. {{ criterion }}</p>
								</div>
							</div>
						</section>

						<section class="execution-panel">
							<div class="tabs" role="tablist">
								<button
									role="tab"
									:aria-selected="tab === 'trace'"
									:class="{ active: tab === 'trace' }"
									@click="tab = 'trace'"
								>
									<Activity :size="16" /><span>执行轨迹</span
									><em>{{ selectedRun.trace.length }}</em>
								</button>
								<button
									role="tab"
									:aria-selected="tab === 'diff'"
									:class="{ active: tab === 'diff' }"
									@click="tab = 'diff'"
								>
									<GitCompareArrows :size="16" /><span>代码 Diff</span>
									<em>{{
										selectedRun.verification.changedPaths.length +
										selectedRun.verification.deletedPaths.length
									}}</em>
								</button>
								<button
									role="tab"
									:aria-selected="tab === 'report'"
									:class="{ active: tab === 'report' }"
									@click="tab = 'report'"
								>
									<ListChecks :size="16" /><span>最终报告</span>
								</button>
							</div>

							<div v-if="tab === 'trace'" class="trace-scroll">
								<div
									v-for="event in selectedRun.trace"
									:key="event.id"
									:class="['trace-row', `trace-${event.status}`]"
								>
									<div class="trace-line">
										<span><component :is="traceIcon(event)" :size="14" /></span>
									</div>
									<div class="trace-body">
										<div class="trace-meta">
											<strong>{{ event.title }}</strong>
											<time>{{ formatTime(event.createdAt) }}</time>
										</div>
										<p>{{ event.summary }}</p>
										<code v-if="event.toolName" class="tool-chip">{{
											event.toolName
										}}</code>
										<button
											v-if="hasTraceData(event)"
											class="details-button"
											@click="toggleTraceDetails(event.id)"
										>
											{{
												expandedTraceId === event.id ? '收起详情' : '查看详情'
											}}
											<ChevronDown :size="13" />
										</button>
										<pre
											v-if="expandedTraceId === event.id"
											class="event-data"
											>{{ JSON.stringify(event.data, null, 2) }}</pre
										>
									</div>
								</div>
								<div
									v-if="selectedRun.status === 'running'"
									class="trace-row trace-info"
								>
									<div class="trace-line">
										<span><LoaderCircle class="spin" :size="14" /></span>
									</div>
									<div class="trace-body waiting-row">
										<strong>Agent 正在决定下一步操作</strong>
										<p>
											Runtime 会先检查预算和状态，再接收 AI 或 Replay Provider
											的决策。
										</p>
									</div>
								</div>
							</div>

							<div v-else-if="tab === 'diff'">
								<div v-if="!latestDiff" class="panel-empty">
									<span><GitBranch :size="25" /></span>
									<strong>还没有代码变化</strong>
									<p>
										Agent 修改文件并执行 get_git_diff 后，差异会显示在这里。
									</p>
								</div>
								<div v-else class="diff-view">
									<div class="changed-files">
										<span
											v-for="path in selectedRun.verification.changedPaths"
											:key="path"
										>
											<FileCode2 :size="14" /> {{ path }}
										</span>
										<span
											v-for="path in selectedRun.verification.deletedPaths"
											:key="path"
											class="deleted-file"
										>
											<XCircle :size="14" /> {{ path }}
										</span>
									</div>
									<pre class="diff-code"><code
										v-for="(line, index) in latestDiff.split('\n')"
										:key="`${index}-${line}`"
										:class="diffLineClass(line)"
									>{{ line || ' ' }}{{ '\n' }}</code></pre>
								</div>
							</div>

							<div v-else-if="tab === 'report'">
								<div v-if="!selectedRun.report" class="panel-empty">
									<span><Clock3 :size="25" /></span>
									<strong>任务仍在执行</strong>
									<p>
										满足完成条件或触发停止条件后，Runtime 会生成结构化报告。
									</p>
								</div>
								<div v-else class="report-view">
									<div
										:class="[
											'report-summary',
											selectedRun.report.status === 'completed'
												? 'success'
												: 'warning'
										]"
									>
										<CheckCircle2
											v-if="selectedRun.report.status === 'completed'"
											:size="24"
										/>
										<AlertTriangle v-else :size="24" />
										<div>
											<strong>{{
												selectedRun.report.status === 'completed'
													? '任务已按完成条件交付'
													: '任务需要继续处理'
											}}</strong>
											<p>{{ selectedRun.report.summary }}</p>
										</div>
									</div>
									<section class="report-section">
										<h3>已满足的完成条件</h3>
										<div
											v-for="item in selectedRun.report.completedCriteria"
											:key="item"
										>
											<CheckCircle2 :size="15" />
											<p>{{ item }}</p>
										</div>
										<p
											v-if="selectedRun.report.completedCriteria.length === 0"
											class="report-empty"
										>
											尚无完成条件通过
										</p>
									</section>
									<section class="report-section">
										<h3>剩余问题</h3>
										<div
											v-for="item in selectedRun.report.remainingIssues"
											:key="item"
										>
											<AlertTriangle :size="15" />
											<p>{{ item }}</p>
										</div>
										<p
											v-if="selectedRun.report.remainingIssues.length === 0"
											class="report-empty"
										>
											没有剩余问题
										</p>
									</section>
									<div class="report-files">
										<div>
											<span>修改文件</span
											><strong>{{
												selectedRun.report.changedPaths.length
											}}</strong>
										</div>
										<div>
											<span>删除文件</span
											><strong>{{
												selectedRun.report.deletedPaths.length
											}}</strong>
										</div>
										<div>
											<span>恢复次数</span
											><strong>{{ selectedRun.usage.recoveryCount }}</strong>
										</div>
									</div>
									<div class="stop-reason">
										<span>Runtime 结论</span>
										<p>{{ selectedRun.report.stopReason }}</p>
									</div>
								</div>
							</div>
						</section>
					</div>
				</template>

				<div v-else class="empty-workspace">
					<div class="empty-visual"><Bot :size="34" /></div>
					<h1>从一个真实的软件任务开始</h1>
					<p>
						Agent
						会在隔离代码库中分析需求、执行工具、修改文件，并用测试结果决定任务能否结束。
					</p>
					<div class="scenario-grid">
						<button
							v-for="scenario in scenarios"
							:key="scenario.id"
							@click="createRun(scenario.id)"
						>
							<span :class="['category', `category-${scenario.category}`]">
								{{ categoryName(scenario.category) }}
							</span>
							<strong>{{ scenario.title }}</strong>
							<p>{{ scenario.shortDescription }}</p>
							<ArrowRight :size="16" />
						</button>
					</div>
				</div>
			</main>
		</div>

		<button
			v-if="sidebarOpen"
			aria-label="关闭侧栏"
			class="sidebar-backdrop mobile-only"
			@click="sidebarOpen = false"
		/>

		<div
			v-if="
				selectedRun?.status === 'waiting_approval' &&
				selectedRun.pendingApproval
			"
			class="modal-backdrop"
			role="presentation"
		>
			<div
				class="approval-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="approval-title"
			>
				<div class="approval-icon"><ShieldAlert :size="24" /></div>
				<div class="approval-copy">
					<span>Human-in-the-Loop</span>
					<h2 id="approval-title">{{ selectedRun.pendingApproval.title }}</h2>
					<p>{{ selectedRun.pendingApproval.description }}</p>
				</div>
				<div class="approval-operation">
					<span>待执行工具</span>
					<code>{{ selectedRun.pendingApproval.action.toolName }}</code>
					<pre>{{
						JSON.stringify(
							selectedRun.pendingApproval.action.arguments,
							null,
							2
						)
					}}</pre>
				</div>
				<div class="approval-warning">
					<AlertTriangle :size="16" />
					<p>
						批准后，Runtime
						将在当前隔离工作区执行此操作，并继续运行测试与类型检查。
					</p>
				</div>
				<div class="dialog-actions">
					<button
						class="secondary-button"
						:disabled="approving"
						@click="approval(false)"
					>
						<X :size="16" /> 拒绝并停止
					</button>
					<button
						class="danger-button"
						:disabled="approving"
						@click="approval(true)"
					>
						<LoaderCircle v-if="approving" :size="16" class="spin" />
						<Check v-else :size="16" /> {{ approving ? '处理中' : '批准执行' }}
					</button>
				</div>
			</div>
		</div>
	</div>
</template>

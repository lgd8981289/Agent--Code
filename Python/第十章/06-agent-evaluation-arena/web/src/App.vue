<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  FlaskConical,
  Play,
  Square,
  Plus,
  Download,
  Upload,
  X,
  GitCompare,
  ClipboardList,
  Layers3,
  ChevronRight,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  FileSearch,
  Trash2,
} from '@lucide/vue'
import {
  faultLabels,
  statusLabels,
  type Batch,
  type CaseResult,
  type Dataset,
  type Mode,
  type SampleGuide,
  type Version,
} from '../../shared/contracts'
import { getDemoScenario, versionBehaviors } from '../../shared/evaluation-guide'

interface Meta {
  configured: boolean
  defaultModel: string
  judgeModel: string
  datasets: Dataset[]
  versions: Version[]
  sampleGuides: Record<string, Record<string, SampleGuide>>
}
interface History {
  id: string
  createdAt: string
  status: string
  mode: Mode
  names: string[]
  completed: number
  total: number
}
const meta = ref<Meta>(),
  history = ref<History[]>([]),
  batch = ref<Batch>(),
  page = ref('arena'),
  error = ref(''),
  busy = ref(false)
const mode = ref<Mode>('replay'),
  datasetId = ref('aftersales-v1'),
  baselineId = ref('baseline'),
  candidateId = ref('fixed'),
  concurrency = ref(1)
const selected = ref<string[]>([]),
  detailId = ref(''),
  sampleId = ref(''),
  view = ref('all'),
  modal = ref(false)
const form = ref({
  name: '',
  model: '',
  prompt: '',
  fault: 'none' as Version['fault'],
  parentId: '',
})
const reviewNote = ref(''),
  reviewVerdict = ref<'agree' | 'disagree'>('agree'),
  importing = ref<HTMLInputElement>()
let timer: ReturnType<typeof setInterval> | undefined,
  polling = false
const dataset = computed(() => meta.value?.datasets.find((d) => d.id === datasetId.value))
const baseline = computed(() => meta.value?.versions.find((v) => v.id === baselineId.value))
const candidate = computed(() => meta.value?.versions.find((v) => v.id === candidateId.value))
const scenario = computed(() => getDemoScenario(baseline.value, candidate.value, dataset.value))
const sameVersion = computed(() => baselineId.value === candidateId.value)
const selectedSample = computed(() => dataset.value?.cases.find((c) => c.id === sampleId.value))
const sampleGuides = computed(() => meta.value?.sampleGuides?.[datasetId.value] || {})
const selectedGuide = computed(() => sampleGuides.value[sampleId.value])
const detail = computed(() => batch.value?.results.find((r) => r.id === detailId.value))
const detailSample = computed(() =>
  batch.value?.dataset.cases.find((c) => c.id === detail.value?.caseId),
)
const done = computed(
  () => batch.value?.results.filter((r) => !['queued', 'running'].includes(r.status)).length || 0,
)
const category = (c: string) =>
  ({ normal: '业务任务', security: '安全测试', control: '合法对照' })[c] || c
const format = (data: unknown) => JSON.stringify(data, null, 2)
const rows = computed(() =>
  (batch.value?.selectedCaseIds || [])
    .map((id) => {
      const b = batch.value!,
        sample = b.dataset.cases.find((c) => c.id === id)!
      const a = b.results.find((r) => r.caseId === id && r.versionId === b.versions[0].id)!,
        c = b.results.find((r) => r.caseId === id && r.versionId === b.versions[1].id)!
      const graded =
        ['passed', 'failed'].includes(a.status) && ['passed', 'failed'].includes(c.status)
      const change = !graded
        ? '待判断'
        : a.status === 'failed' && c.status === 'passed'
          ? '修复'
          : a.status === 'passed' && c.status === 'failed'
            ? '退步'
            : '保持'
      return { sample, a, b: c, change }
    })
    .filter(
      (row) =>
        view.value === 'all' ||
        (view.value === 'changed'
          ? ['修复', '退步'].includes(row.change)
          : row.sample.category === view.value),
    ),
)
const summaries = computed(
  () =>
    batch.value?.versions.map((v) => {
      const results = batch.value!.results.filter((r) => r.versionId === v.id),
        passed = results.filter((r) => r.status === 'passed').length
      const tokenSum = (role: 'agentUsage' | 'judgeUsage') => {
        if (batch.value!.mode === 'replay') return '未调用模型'
        if (results.some((r) => r[role].input === null || r[role].output === null))
          return '用量不完整'
        return `${results.reduce((n, r) => n + r[role].input! + r[role].output!, 0).toLocaleString()} Token`
      }
      return {
        version: v,
        passed,
        total: results.length,
        errors: results.filter((r) => r.status.endsWith('_error')).length,
        safety: results.filter((r) => r.checks.some((c) => c.kind === 'safety' && !c.passed))
          .length,
        agentTokens: tokenSum('agentUsage'),
        judgeTokens: tokenSum('judgeUsage'),
        duration: results.reduce(
          (n, r) => n + (r.trace.find((t) => t.name === 'agent.run')?.durationMs || 0),
          0,
        ),
      }
    }) || [],
)
async function api<T>(path: string, body?: unknown, method?: 'DELETE'): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...(method ? { method } : {}),
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `请求失败 ${res.status}`)
  return data
}
async function act(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
async function refresh() {
  meta.value = await api<Meta>('/meta')
  history.value = await api<History[]>('/runs')
}
watch(dataset, (value) => {
  if (value) selected.value = value.cases.map((c) => c.id)
})
async function openRun(id: string) {
  batch.value = await api<Batch>(`/runs/${id}`)
  page.value = 'arena'
  detailId.value = ''
}
async function start(caseIds = selected.value) {
  await act(async () => {
    const run = await api<{ id: string }>('/runs', {
      datasetId: datasetId.value,
      baselineId: baselineId.value,
      candidateId: candidateId.value,
      mode: mode.value,
      caseIds,
      concurrency: concurrency.value,
    })
    await openRun(run.id)
    await refresh()
  })
}
function useScenario(name: 'amount' | 'regression' | 'safety') {
  mode.value = 'replay'
  datasetId.value = 'aftersales-v1'
  page.value = 'arena'
  baselineId.value = name === 'regression' ? 'fixed' : name === 'safety' ? 'fixed' : 'baseline'
  candidateId.value = name === 'regression' ? 'regression' : name === 'safety' ? 'unsafe' : 'fixed'
  selected.value = meta
    .value!.datasets.find((d) => d.id === 'aftersales-v1')!
    .cases.map((c) => c.id)
}
function cloneVersion(v: Version) {
  form.value = {
    name: `${v.name} · 新版本`,
    model: v.model,
    prompt: v.prompt,
    fault: v.fault,
    parentId: v.id,
  }
  detailId.value = ''
  modal.value = true
}
async function deleteVersion(v: Version) {
  if (!window.confirm(`删除“${v.name}”？已用于评测或被其他版本引用的版本会保留。`)) return
  await act(async () => {
    await api(`/versions/${encodeURIComponent(v.id)}`, undefined, 'DELETE')
    if (baselineId.value === v.id) baselineId.value = 'baseline'
    if (candidateId.value === v.id) candidateId.value = 'fixed'
    await refresh()
  })
}
async function saveVersion() {
  await act(async () => {
    const v = await api<Version>('/versions', form.value)
    await refresh()
    candidateId.value = v.id
    modal.value = false
    page.value = 'arena'
  })
}
async function importDataset(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  await act(async () => {
    if (file.size > 2_000_000) throw new Error('文件不能超过 2 MB')
    const d = await api<Dataset>('/datasets', JSON.parse(await file.text()))
    await refresh()
    datasetId.value = d.id
    mode.value = 'ai'
  })
  ;(event.target as HTMLInputElement).value = ''
}
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([format(data)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function rerunDetail() {
  if (!batch.value || !detail.value) return
  datasetId.value = batch.value.dataset.id
  baselineId.value = batch.value.versions[0].id
  candidateId.value = batch.value.versions[1].id
  mode.value = batch.value.mode
  void start([detail.value.caseId])
}
async function saveReview() {
  await act(async () => {
    await api(`/runs/${batch.value!.id}/reviews/${detailId.value}`, {
      verdict: reviewVerdict.value,
      note: reviewNote.value,
    })
    reviewNote.value = ''
    batch.value = await api(`/runs/${batch.value!.id}`)
  })
}
function closeOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    modal.value = false
    sampleId.value = ''
    detailId.value = ''
  }
}
watch(() => Boolean(modal.value || sampleId.value || detailId.value), open => {
  document.body.style.overflow = open ? 'hidden' : ''
})
onMounted(async () => {
  window.addEventListener('keydown', closeOnEscape)
  await act(refresh)
  timer = setInterval(async () => {
    if (polling || batch.value?.status !== 'running') return
    polling = true
    const id = batch.value.id
    try {
      const updated = await api<Batch>(`/runs/${id}`)
      if (batch.value?.id === id) batch.value = updated
      history.value = await api('/runs')
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      polling = false
    }
  }, 800)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('keydown', closeOnEscape)
  document.body.style.overflow = ''
})
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <FlaskConical :size="23" /><strong>Agent 质量评测竞技场</strong
      ><span class="local">LOCAL LAB</span>
    </div>
    <span class="connection"
      ><i :class="{ ready: meta }" />{{ meta ? '服务已连接' : '连接中' }}</span
    >
  </header>
  <div class="shell">
    <aside class="sidebar">
      <nav aria-label="主导航">
        <button :class="{ active: page === 'arena' }" @click="page = 'arena'">
          <GitCompare :size="18" />评测对比</button
        ><button :class="{ active: page === 'datasets' }" @click="page = 'datasets'">
          <ClipboardList :size="18" />测试数据集 <span>{{ dataset?.cases.length }}</span></button
        ><button :class="{ active: page === 'versions' }" @click="page = 'versions'">
          <Layers3 :size="18" />Agent 版本 <span>{{ meta?.versions.length }}</span>
        </button>
      </nav>
      <div class="aside-heading">教学场景</div>
      <button class="scenario" @click="useScenario('amount')">
        <span class="scenario-no">01</span><span>定位金额错误<small>v1 → v2</small></span
        ><ChevronRight :size="14" />
      </button>
      <button class="scenario" @click="useScenario('regression')">
        <span class="scenario-no">02</span><span>发现连续对话退步<small>v2 → v3</small></span
        ><ChevronRight :size="14" />
      </button>
      <button class="scenario" @click="useScenario('safety')">
        <span class="scenario-no">03</span><span>检查安全失败<small>v2 → v4</small></span
        ><ChevronRight :size="14" />
      </button>
      <div class="aside-heading">
        评测历史
        <button class="icon" title="刷新历史" @click="act(refresh)">
          <RefreshCw :size="14" />
        </button>
      </div>
      <div class="history">
        <button
          v-for="h in history"
          :key="h.id"
          :class="{ chosen: batch?.id === h.id }"
          @click="act(() => openRun(h.id))"
        >
          <span
            >{{ h.mode === 'replay' ? '演示' : '真实模型' }} ·
            {{ new Date(h.createdAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span
          ><small>{{ h.names[0] }} → {{ h.names[1] }}</small
          ><small>{{ h.completed }} / {{ h.total }} · {{ h.status }}</small>
        </button>
        <p v-if="!history.length" class="muted">暂无评测记录</p>
      </div>
      <footer>CHAPTER 10 · EVALUATION</footer>
    </aside>
    <main>
      <div v-if="error" class="alert error" role="alert">
        <AlertTriangle :size="18" /><span>{{ error }}</span
        ><button class="icon" title="关闭提示" @click="error = ''"><X :size="16" /></button>
      </div>
      <template v-if="page === 'arena'">
        <div class="page-heading">
          <div>
            <p class="eyebrow">EXPERIMENT</p>
            <h1>在同一组任务上，比较两个版本</h1>
          </div>
          <span class="tag">{{ dataset?.name }}</span>
        </div>
        <section class="config">
          <div class="config-top">
            <div class="segmented" aria-label="运行模式">
              <button :class="{ selected: mode === 'replay' }" @click="mode = 'replay'">
                Replay 演示</button
              ><button :class="{ selected: mode === 'ai' }" @click="mode = 'ai'">真实模型</button>
            </div>
            <span class="muted">{{
              mode === 'replay'
                ? '预设决策 + 真实工具执行 · 不调用模型'
                : `Agent + Judge 均调用模型 · Judge: ${meta?.judgeModel}`
            }}</span>
          </div>
          <div v-if="scenario" class="scenario-brief" aria-labelledby="scenario-title">
            <div class="scenario-heading">
              <h2 id="scenario-title">{{ scenario.title }}</h2>
              <span class="tag">预设教学故障</span>
            </div>
            <p>{{ scenario.description }}</p>
            <dl>
              <div>
                <dt>代表任务</dt>
                <dd>
                  <p v-for="(turn, i) in scenario.sample.turns" :key="i">
                    <span v-if="scenario.sample.turns.length > 1">第 {{ i + 1 }} 轮：</span>{{ turn.question }}
                  </p>
                  <span v-if="!selected.includes(scenario.sample.id)" class="warning">此代表任务未选中，本次不会执行。</span>
                </dd>
              </div>
              <div><dt>检查重点</dt><dd>{{ scenario.focus }}</dd></div>
            </dl>
          </div>
          <div class="config-grid">
            <div class="version-choice">
              <label for="baseline-version">基线版本 A · 作为对照</label>
              <select id="baseline-version" v-model="baselineId" aria-describedby="baseline-behavior">
                <option v-for="v in meta?.versions" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
              <div v-if="baseline" id="baseline-behavior" class="version-behavior">
                <p>{{ versionBehaviors[baseline.fault].description }}</p>
                <p class="behavior-example">{{ versionBehaviors[baseline.fault].example }}</p>
              </div>
            </div>
            <div class="version-choice">
              <label for="candidate-version">候选版本 B · 本次待检查</label>
              <select id="candidate-version" v-model="candidateId" aria-describedby="candidate-behavior">
                <option v-for="v in meta?.versions" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
              <div v-if="candidate" id="candidate-behavior" class="version-behavior">
                <p>{{ versionBehaviors[candidate.fault].description }}</p>
                <p class="behavior-example">{{ versionBehaviors[candidate.fault].example }}</p>
              </div>
            </div>
          </div>
          <div class="config-bottom">
            <div>
              <button class="text-button" @click="page = 'datasets'">
                已选 {{ selected.length }} / {{ dataset?.cases.length }} 条样本
                <ChevronRight :size="14" /></button>
              <p class="muted">A、B 分别执行这同一组 {{ selected.length }} 条任务，共 {{ selected.length * 2 }} 次样本执行。</p>
              <p v-if="mode === 'ai' && !meta?.configured" class="warning">未配置 API Key</p>
              <p v-else-if="mode === 'ai'" class="muted">会产生实际 API 调用费用</p>
            </div>
            <div class="run-controls">
              <label>并发<select v-model="concurrency">
                <option :value="1">1</option>
                <option :value="2">2</option>
              </select></label>
              <button
                class="primary"
                :disabled="!meta || busy || batch?.status === 'running' || !selected.length || sameVersion"
                :aria-describedby="sameVersion ? 'same-version-warning' : undefined"
                @click="start()"
              >
                <Play :size="17" />开始评测
              </button>
            </div>
          </div>
          <p v-if="meta && sameVersion" id="same-version-warning" class="selection-warning" role="alert">
            <AlertTriangle :size="16" />A、B 当前选择了同一个 Agent 版本，无法开始对比。请选择两个不同版本；它们会执行同一组测试任务。
          </p>
        </section>
        <section v-if="!batch" class="empty">
          <GitCompare :size="42" />
          <h2>还没有评测结果</h2>
          <p>
            当前选择：{{ meta?.versions.find((v) => v.id === baselineId)?.name }} 对比
            {{ meta?.versions.find((v) => v.id === candidateId)?.name }}
          </p>
        </section>
        <template v-else>
          <div class="report-heading">
            <div>
              <h2>
                本次评测
                <span class="tag">{{ batch.mode === 'replay' ? '演示数据' : '真实模型结果' }}</span>
              </h2>
              <p class="muted">
                {{ new Date(batch.createdAt).toLocaleString('zh-CN') }} ·
                {{ batch.evaluatorVersion }} · {{ done }} / {{ batch.results.length }} 已结束
              </p>
            </div>
            <div class="actions">
              <button
                v-if="batch.status === 'running'"
                @click="act(() => api(`/runs/${batch!.id}/cancel`, {}))"
              >
                <Square :size="15" />取消</button
              ><button
                title="下载包含配置快照和 Trace 的报告"
                @click="download(batch, `evaluation-${batch.id}.json`)"
              >
                <Download :size="16" />报告</button
              ><button
                :disabled="busy || batch.status === 'running'"
                @click="
                  act(async () => {
                    batch!.gate = await api(`/runs/${batch!.id}/gate`, {})
                  })
                "
              >
                <CheckCircle2 :size="16" />发布检查
              </button>
            </div>
          </div>
          <progress :value="done" :max="batch.results.length" aria-label="评测进度" />
          <div class="summaries">
            <div v-for="(s, i) in summaries" :key="s.version.id" class="summary">
              <div class="summary-title">
                <span class="letter">{{ i === 0 ? 'A' : 'B' }}</span
                ><strong>{{ s.version.name }}</strong
                ><span class="muted">{{ batch.mode === 'ai' ? s.version.model : '脚本决策' }}</span>
              </div>
              <div class="score">
                <strong
                  >{{ s.passed }}<small>/ {{ s.total }}</small></strong
                ><span>样本通过</span>
                <div class="summary-stats">
                  <span
                    >安全失败 <b :class="{ danger: s.safety }">{{ s.safety }}</b></span
                  ><span
                    >运行 / 评分异常 <b>{{ s.errors }}</b></span
                  >
                </div>
              </div>
              <div class="mini-bar">
                <span :style="{ width: `${(s.passed / s.total) * 100}%` }" />
              </div>
              <div class="usage">
                <span>Agent：{{ s.agentTokens }}</span
                ><span>Judge：{{ s.judgeTokens }}</span
                ><span>任务累计 {{ (s.duration / 1000).toFixed(2) }} s</span>
              </div>
            </div>
          </div>
          <div v-if="batch.gate" class="gate" :class="batch.gate.status">
            <CheckCircle2 v-if="batch.gate.status === 'passed'" :size="24" /><AlertTriangle
              v-else
              :size="24"
            />
            <div>
              <strong>{{
                batch.gate.status === 'passed'
                  ? '当前测试集检查通过'
                  : batch.gate.status === 'blocked'
                    ? '发布检查未通过'
                    : '发布检查待确认'
              }}</strong>
              <p v-for="reason in batch.gate.reasons" :key="reason">{{ reason }}</p>
            </div>
            <span class="tag"
              >{{ batch.mode === 'replay' ? '演示结论' : '测试结论' }} · 不执行部署</span
            >
          </div>
          <div class="table-tools">
            <h2>逐题对比</h2>
            <select v-model="view" aria-label="结果筛选">
              <option value="all">全部样本</option>
              <option value="changed">只看修复 / 退步</option>
              <option value="normal">业务任务</option>
              <option value="security">安全测试</option>
              <option value="control">合法对照</option>
            </select>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>任务 / 检查类别</th>
                  <th>基线 A</th>
                  <th>候选 B</th>
                  <th>变化</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.sample.id">
                  <td>
                    <strong>{{ row.sample.name }}</strong
                    ><small
                      >{{ category(row.sample.category) }} · {{ row.sample.turns.length }} 轮</small
                    >
                  </td>
                  <td>
                    <button class="status" :class="row.a.status" @click="detailId = row.a.id">
                      {{ statusLabels[row.a.status] }}
                    </button>
                  </td>
                  <td>
                    <button class="status" :class="row.b.status" @click="detailId = row.b.id">
                      {{ statusLabels[row.b.status] }}
                    </button>
                  </td>
                  <td :class="{ positive: row.change === '修复', danger: row.change === '退步' }">
                    {{ row.change }}
                  </td>
                  <td>
                    <button
                      class="icon"
                      title="查看候选版本的评分与执行轨迹"
                      @click="detailId = row.b.id"
                    >
                      <FileSearch :size="18" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="footnote">
            通过数量按全部已选样本统计；待执行、异常和取消均不算通过。{{
              batch.mode === 'replay'
                ? '演示回答由固定规则检查，不用于判断模型优劣。'
                : '单次评测有波动，关键任务需要重复验证。'
            }}
          </p>
        </template>
      </template>
      <template v-else-if="page === 'datasets'">
        <div class="page-heading">
          <div>
            <p class="eyebrow">DATASET</p>
            <h1>测试数据集</h1>
          </div>
          <div class="actions">
            <button
              @click="download({ name: dataset!.name, cases: dataset!.cases }, 'dataset.json')"
            >
              <Download :size="16" />导出</button
            ><button @click="importing?.click()"><Upload :size="16" />导入 JSON</button
            ><input
              ref="importing"
              hidden
              type="file"
              accept="application/json,.json"
              @change="importDataset"
            />
          </div>
        </div>
        <div class="table-tools">
          <select v-model="datasetId" aria-label="数据集">
            <option v-for="d in meta?.datasets" :key="d.id" :value="d.id">
              {{ d.name }}
            </option></select
          ><button class="text-button" @click="selected = dataset!.cases.map((c) => c.id)">
            全选</button
          ><span class="muted"
            >已选 {{ selected.length }} 条 · {{ dataset?.hash.slice(0, 12) }}</span
          >
        </div>
        <div class="table-wrap dataset-table">
          <table aria-label="测试题目与通过条件">
            <thead>
              <tr>
                <th>选择</th>
                <th>每道题问什么</th>
                <th>提供什么业务资料</th>
                <th>怎样才算通过</th>
                <th><span class="sr-only">完整详情</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in dataset?.cases" :key="c.id">
                <td class="sample-selection">
                  <input v-model="selected" type="checkbox" :value="c.id" :aria-label="c.name" />
                </td>
                <td class="sample-question">
                  <strong>{{ c.name }}</strong>
                  <small>{{ category(c.category) }} · {{ c.turns.length }} 轮</small>
                  <div v-for="(t, i) in c.turns" :key="i" class="sample-turn">
                    <span v-if="c.turns.length > 1">第 {{ i + 1 }} 轮 · 会话 {{ t.session }}</span>
                    <p>{{ t.question }}</p>
                  </div>
                  <p v-if="c.turns.length > 1" class="sample-conversation">{{ sampleGuides[c.id]?.conversation }}</p>
                </td>
                <td class="sample-materials" data-label="提供什么业务资料">
                  <dl class="sample-facts">
                    <div v-for="fact in sampleGuides[c.id]?.materials" :key="fact.label">
                      <dt>{{ fact.label }}</dt><dd>{{ fact.value }}</dd>
                    </div>
                  </dl>
                </td>
                <td class="sample-pass" data-label="怎样才算通过">
                  <p>{{ c.expected.answerRequirement }}</p>
                  <p class="sample-outcome">{{ sampleGuides[c.id]?.outcome }}</p>
                </td>
                <td class="sample-action">
                  <button class="icon" title="查看输入与检查要求" @click="sampleId = c.id">
                    <FileSearch :size="18" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <button class="primary back" @click="page = 'arena'">
          返回评测 <ChevronRight :size="17" />
        </button>
      </template>
      <template v-else>
        <div class="page-heading">
          <div>
            <p class="eyebrow">VERSIONS</p>
            <h1>Agent 版本</h1>
          </div>
        </div>
        <div class="table-wrap versions-table">
          <table>
            <thead>
              <tr>
                <th>版本</th>
                <th>模型</th>
                <th>流程配置 · 程序怎样处理任务</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in meta?.versions" :key="v.id">
                <td>
                  <strong>{{ v.name }}</strong
                  ><small>{{ ['baseline', 'fixed', 'regression', 'unsafe'].includes(v.id) ? '内置教学版本' : '自定义版本' }}</small>
                </td>
                <td>{{ v.model }}</td>
                <td class="version-config">
                  <strong>{{ faultLabels[v.fault] }}</strong>
                  <dl class="config-facts">
                    <div><dt>实际行为</dt><dd>{{ versionBehaviors[v.fault].description }}</dd></div>
                    <div><dt>具体例子</dt><dd>{{ versionBehaviors[v.fault].walkthrough }}</dd></div>
                    <div><dt>评测目的</dt><dd>{{ versionBehaviors[v.fault].evaluation }}</dd></div>
                  </dl>
                  <p class="config-note">{{ versionBehaviors[v.fault].note }}</p>
                </td>
                <td>
                  <div class="version-actions">
                    <button @click="cloneVersion(v)"><Plus :size="16" />复制为新版本</button>
                    <button v-if="!['baseline', 'fixed', 'regression', 'unsafe'].includes(v.id)"
                      class="icon" :title="`删除版本：${v.name}`" :disabled="busy" @click="deleteVersion(v)">
                      <Trash2 :size="16" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </main>
  </div>
  <div v-if="modal" class="overlay" @click.self="modal = false">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="创建 Agent 版本">
      <div class="dialog-head">
        <h2>复制为新版本</h2>
        <button class="icon" title="关闭" @click="modal = false"><X /></button>
      </div>
      <form @submit.prevent="saveVersion">
        <label>版本名称<input v-model="form.name" required maxlength="80" /></label
        ><label>模型<input v-model="form.model" required maxlength="120" /></label
        ><label
          >流程配置<select v-model="form.fault">
            <option v-for="(label, value) in faultLabels" :key="value" :value="value">
              {{ label }}
            </option>
          </select></label>
        <div class="form-behavior">
          <p>{{ versionBehaviors[form.fault].description }}</p>
          <dl class="config-facts">
            <div><dt>具体例子</dt><dd>{{ versionBehaviors[form.fault].walkthrough }}</dd></div>
            <div><dt>评测目的</dt><dd>{{ versionBehaviors[form.fault].evaluation }}</dd></div>
          </dl>
          <p class="config-note">{{ versionBehaviors[form.fault].note }}</p>
        </div>
        <label
          >System Prompt<textarea
            v-model="form.prompt"
            rows="10"
            required
            maxlength="8000"
          /></label
        ><button class="primary" :disabled="busy">保存新版本</button>
      </form>
    </section>
  </div>
  <div v-if="selectedSample" class="overlay" @click.self="sampleId = ''">
    <section class="dialog sample-dialog" role="dialog" aria-modal="true" aria-label="测试样本">
      <div class="dialog-head">
        <h2>{{ selectedSample.name }}</h2>
        <button class="icon" title="关闭" @click="sampleId = ''"><X /></button>
      </div>
      <div class="sample-detail-grid">
        <div>
          <h3>每道题问什么</h3>
          <div v-for="(t, i) in selectedSample.turns" :key="i" class="turn">
            <small>第 {{ i + 1 }} 轮 · 会话 {{ t.session }}</small>
            <p>{{ t.question }}</p>
          </div>
          <p class="sample-conversation">{{ selectedGuide?.conversation }}</p>
          <h3>提供什么业务资料</h3>
          <p class="sample-note">以下为测试环境中的资料。Agent 通过工具按权限查询；其他用户的订单仅供核对越权行为，不能返回给当前用户。</p>
          <dl v-if="selectedGuide" class="sample-facts full-facts">
            <div><dt>当前身份</dt><dd>{{ selectedGuide.context }}</dd></div>
            <div v-if="selectedSample.expected.orderId"><dt>本题核对订单</dt><dd>{{ selectedGuide.materials[0].value }}</dd></div>
            <div><dt>初始记录</dt><dd>{{ selectedGuide.initialState }}</dd></div>
            <div><dt>退款审批</dt><dd>{{ selectedGuide.approvals }}</dd></div>
            <div><dt>规则正文 · read_policy 的实际返回内容</dt><dd class="policy-text">{{ selectedGuide.document }}</dd></div>
          </dl>
          <h4>测试订单与访问范围</h4>
          <ul class="sample-orders">
            <li v-for="order in selectedGuide?.orders" :key="order.orderId">
              <strong>{{ order.orderId }} · {{ order.description }}</strong>
              <small>{{ order.ownership }}</small>
              <span :class="order.accessible ? 'positive' : 'danger'">{{ order.accessible ? '当前用户可读取' : '当前用户无权读取，不得泄露商品与金额' }}</span>
            </li>
          </ul>
        </div>
        <div class="sample-criteria">
          <h3>怎样才算通过 <span class="tag">仅供评分</span></h3>
          <p class="sample-note">评分标准不发送给答题 Agent。规则、安全检查与回答检查都通过，这道题才算通过。</p>
          <h4>回答需要满足什么</h4>
          <p class="answer-requirement">{{ selectedSample.expected.answerRequirement }}</p>
          <h4>程序检查哪些执行结果</h4>
          <ul class="sample-checks">
            <li v-for="rule in selectedGuide?.rules" :key="rule">{{ rule }}</li>
          </ul>
          <h4>每道题共同遵守的安全要求</h4>
          <ul class="sample-checks">
            <li v-for="rule in selectedGuide?.safety" :key="rule">{{ rule }}</li>
          </ul>
          <p class="sample-note">Replay 使用固定规则检查演示回答；真实模型模式使用 LLM-as-a-Judge 评阅回答。自动评分有误判可能，可在评测结果中人工复核。</p>
          <details class="sample-config">
            <summary>原始测试配置</summary>
            <pre>{{ format({ fixture: selectedSample.fixture, expected: selectedSample.expected }) }}</pre>
          </details>
        </div>
      </div>
    </section>
  </div>
  <div v-if="detail && batch" class="overlay" @click.self="detailId = ''">
    <section class="dialog wide" role="dialog" aria-modal="true" aria-label="评分与执行轨迹">
      <div class="dialog-head">
        <div>
          <h2>{{ detailSample?.name }}</h2>
          <small
            >{{ batch.versions.find((v) => v.id === detail!.versionId)?.name }} ·
            {{ statusLabels[detail.status] }}</small
          >
        </div>
        <button class="icon" title="关闭" @click="detailId = ''"><X /></button>
      </div>
      <div class="detail-grid">
        <div class="detail-left">
          <h3>问题与实际回答</h3>
          <div v-for="(t, i) in detail.turns" :key="i" class="turn">
            <small>第 {{ i + 1 }} 轮 · 会话 {{ t.session }}</small>
            <p class="question">{{ t.question }}</p>
            <p>{{ t.answer }}</p>
          </div>
          <p v-if="detail.error" class="danger">{{ detail.error }}</p>
          <h3>检查要求</h3>
          <p>{{ detailSample?.expected.answerRequirement }}</p>
          <h3>规则检查</h3>
          <div v-for="c in detail.checks" :key="c.name" class="check">
            <CheckCircle2 v-if="c.passed" class="positive" :size="16" /><AlertTriangle
              v-else
              class="danger"
              :size="16"
            /><span>{{ c.name }}</span
            ><b>{{ c.passed ? '通过' : '未通过' }}</b>
          </div>
          <h3>
            {{ detail.judge?.method === 'llm' ? 'LLM-as-a-Judge' : '演示回答检查（未调用 LLM）' }}
          </h3>
          <p>{{ detail.judge?.reason || '尚未评分' }}</p>
          <blockquote v-for="q in detail.judge?.quotes" :key="q">{{ q }}</blockquote>
          <div class="actions">
            <button @click="rerunDetail"><RefreshCw :size="16" />只重跑这道题</button
            ><button @click="cloneVersion(batch.versions.find((v) => v.id === detail!.versionId)!)">
              <Plus :size="16" />复制版本
            </button>
          </div>
          <h3>人工复核</h3>
          <select v-model="reviewVerdict" aria-label="复核结论">
            <option value="agree">认可自动评分</option>
            <option value="disagree">质疑自动评分</option></select
          ><textarea
            v-model="reviewNote"
            rows="3"
            maxlength="2000"
            placeholder="填写依据，保留原自动评分"
          /><button :disabled="busy || !reviewNote.trim()" @click="saveReview">保存复核意见</button>
          <p v-for="r in detail.reviews" :key="r.at" class="review">
            {{ r.verdict === 'agree' ? '认可' : '质疑' }}：{{ r.note }}
          </p>
        </div>
        <div class="detail-right">
          <h3>
            执行轨迹 <span class="tag">{{ detail.trace.length }} steps</span>
          </h3>
          <details
            v-for="(s, index) in detail.trace"
            :key="s.id"
            class="trace"
            :class="{ root: !s.parentId }"
          >
            <summary>
              <span class="trace-index">{{ String(index + 1).padStart(2, '0') }}</span
              ><span>{{ s.name }}</span
              ><small>{{ s.durationMs }} ms</small>
            </summary>
            <h4>输入</h4>
            <pre>{{ format(s.input) }}</pre>
            <h4>输出</h4>
            <pre>{{ format(s.output) }}</pre>
            <p v-if="s.error" class="danger">{{ s.error }}</p>
          </details>
          <details class="trace root">
            <summary>最终业务数据：退款与记忆</summary>
            <pre>{{ format(detail.after) }}</pre>
          </details>
        </div>
      </div>
    </section>
  </div>
</template>

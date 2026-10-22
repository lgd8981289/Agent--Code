<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { Play, CheckCircle2, XCircle, FlaskConical, Download } from "@lucide/vue";
import type { EvaluationReport } from "../../shared/types";
import { compareEvaluations } from "../../shared/evaluation-comparison";
import { api, time } from "./api";
const props = defineProps<{ reports: EvaluationReport[] }>(),
  emit = defineEmits<{
    changed: [];
    error: [message: string];
    busy: [value: boolean];
  }>();
const mode = ref<"replay" | "ai">("replay"),
  model = ref(""),
  prompt = ref(""),
  comparisonId = ref("");
const running = ref(false),
  version = ref("current"),
  selected = ref("");
watch(mode, () => {
  if (mode.value === "ai") version.value = "current";
});
watch(running, (value) => emit("busy", value));
onUnmounted(() => emit("busy", false));
const report = computed(
  () => props.reports.find((r) => r.id === selected.value) || props.reports[0],
);
watch(
  () => props.reports.map((r) => r.id).join(","),
  () => {
    if (!props.reports.some((r) => r.id === selected.value))
      selected.value = props.reports[0]?.id || "";
  },
  { immediate: true },
);
const comparison = computed(() => {
  const previous = props.reports.find((r) => r.id === comparisonId.value);
  return report.value && previous ? compareEvaluations(report.value, previous) : null;
});
async function run() {
  running.value = true;
  try {
    const r = await api<EvaluationReport>("/evaluations", {
      version: version.value,
      mode: mode.value,
      ...(model.value.trim() && mode.value === "ai"
        ? { model: model.value.trim() }
        : {}),
      ...(prompt.value.trim() && mode.value === "ai"
        ? { prompt: prompt.value.trim() }
        : {}),
    });
    selected.value = r.id;
    emit("changed");
  } catch (e) {
    emit("error", (e as Error).message);
  } finally {
    running.value = false;
  }
}
function download() {
  if (!report.value) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report.value, null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `evaluation-${report.value.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>
<template>
  <div class="evaluation-view">
    <header class="section-head">
      <div>
        <div class="eyebrow">质量验证</div>
        <h2>检查回答，也核对实际执行</h2>
      </div>
      <FlaskConical :size="27" />
    </header>
    <div class="evaluation-controls">
      <label
        >执行方式<select aria-label="执行方式" v-model="mode" :disabled="running">
          <option value="replay">Replay · 业务回归</option>
          <option value="ai">AI · 业务回归 + 真实模型任务</option>
        </select></label
      >
      <label
        >被测版本<select aria-label="被测版本" v-model="version" :disabled="running">
          <option value="current">v2 · 当前实现</option>
          <option value="baseline" :disabled="mode === 'ai'">v1 · 金额展示故障</option>
        </select></label
      ><button class="primary" :disabled="running" @click="run">
        <Play :size="17" />{{ running ? "正在隔离环境执行…" : "开始回归验证" }}
      </button>
    </div>
    <details v-if="mode === 'ai'" class="context-section">
      <summary>模型与提示词配置</summary>
      <label
        >模型名称<input
          v-model="model"
          :disabled="running"
          placeholder="留空使用项目配置"
      /></label>
      <label
        >咨询提示词<textarea
          v-model="prompt"
          :disabled="running"
          placeholder="留空使用默认提示词；身份、证据和审批规则始终保留"
          maxlength="6000"
        ></textarea>
      </label>
      <p class="muted">
        AI 模式会调用已配置的模型与检索服务，产生对应费用。每轮预算最多 6 次模型调用、10
        次工具调用。
      </p>
    </details>
    <p class="muted">
      每批测试使用独立数据库，运行真实 MCP 工具和持久化流程。v1
      只在评测环境中将实付金额错误缩小 100 倍。
    </p>
    <template v-if="report"
      ><div class="evaluation-stats">
        <div>
          <small>通过样本</small
          ><strong
            >{{ report.passed }}<span> / {{ report.total }}</span></strong
          >
        </div>
        <div>
          <small>发布检查</small
          ><strong :class="report.gate === 'passed' ? 'green' : 'red'">{{
            report.gate === "passed" ? "通过" : "阻止发布"
          }}</strong>
        </div>
        <div>
          <small>{{ report.version }}</small
          ><span>{{ time(report.at) }}</span>
        </div>
        <button class="icon-button" title="下载评分报告" @click="download">
          <Download :size="20" />
        </button>
      </div>
      <div class="report-select">
        <label
          >历史报告<select aria-label="历史报告" v-model="selected">
            <option v-for="r in reports" :key="r.id" :value="r.id">
              {{ r.version }} · {{ time(r.at) }} · {{ r.passed }}/{{ r.total }}
            </option>
          </select></label
        >
      </div>
      <p class="scope-note">{{ report.scope }}</p>
      <details v-if="report.snapshot" class="context-section">
        <summary>本次配置快照</summary>
        <p>
          模型：{{ report.snapshot.model }} · Judge：{{ report.snapshot.judgeModel }} ·
          检索：{{ report.snapshot.knowledgeBackend }}
        </p>
        <p>
          数据集：{{ report.snapshot.datasetVersion }} · 代码：{{
            report.snapshot.codeHash.slice(0, 12)
          }}
          · 政策：{{ report.snapshot.knowledgeHash.slice(0, 12) }}
        </p>
        <p>提示词：{{ report.snapshot.prompt }}</p>
        <small>完整摘要、问答和调用轨迹包含在下载报告中。</small>
      </details>
      <label
        >对比报告<select aria-label="对比报告" v-model="comparisonId">
          <option value="">不比较</option>
          <option
            v-for="r in reports.filter((r) => r.id !== report.id)"
            :key="r.id"
            :value="r.id"
          >
            {{ r.mode }} · {{ r.version }} · {{ time(r.at) }}
          </option>
        </select></label
      >
      <p v-if="comparison?.error" class="notice warning">
        {{ comparison.error }}
      </p>
      <table v-else-if="comparison" class="comparison-table">
        <thead>
          <tr>
            <th>样本</th>
            <th>之前</th>
            <th>本次</th>
            <th>变化</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in comparison.rows" :key="row.id">
            <td>{{ row.name }}</td>
            <td>{{ row.before }}</td>
            <td>{{ row.after }}</td>
            <td>{{ row.change }}</td>
          </tr>
        </tbody>
      </table>
      <div class="result-table">
        <div class="result-table-head">
          <span>测试任务</span><span>预期与实际</span><span>结果</span>
        </div>
        <div v-for="item in report.items" :key="item.id" class="result-table-row">
          <strong>{{ item.name }}</strong>
          <div>
            <small>要求：{{ item.expected }}</small>
            <p>{{ item.actual }}</p>
            <small v-if="item.rule"
              >规则：{{ item.rule.status }} · {{ item.rule.reason }}</small
            >
            <small v-if="item.judge"
              >Judge：{{ item.judge.status }} · {{ item.judge.reason }}</small
            >
            <details v-if="item.traces">
              <summary>调用轨迹（{{ item.traces.length }} 条）</summary>
              <p v-for="trace in item.traces" :key="trace.id">
                {{ trace.kind }} / {{ trace.name }} · {{ trace.status }} ·
                {{ trace.durationMs }} ms
              </p>
            </details>
          </div>
          <span class="result-badge" :class="item.status"
            ><CheckCircle2 v-if="item.status === 'passed'" :size="16" /><XCircle
              v-else
              :size="16"
            />{{
              item.status === "passed"
                ? "通过"
                : item.status === "failed"
                  ? "未通过"
                  : "执行异常"
            }}</span
          >
        </div>
      </div></template
    >
    <div v-else class="empty-state">
      <FlaskConical :size="40" />
      <h3>准备好同一组任务</h3>
      <p>涵盖订单金额、材料、权限、审批版本、执行恢复、记忆与报告引用。</p>
    </div>
  </div>
</template>

<style scoped>
.comparison-table {
  width: 100%;
  margin: 16px 0;
  border-collapse: collapse;
  font-size: 13px;
}
.comparison-table th,
.comparison-table td {
  text-align: left;
  padding: 10px;
  border-bottom: 1px solid var(--border, #e0e5ea);
}
.context-section label {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}
.context-section textarea {
  min-height: 96px;
}
</style>

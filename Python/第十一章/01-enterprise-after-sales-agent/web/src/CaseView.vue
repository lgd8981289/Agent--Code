<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import {
  Check,
  X,
  RotateCcw,
  FileSearch,
  Download,
  ShieldCheck,
  ArrowRight,
  Clock,
  CircleCheck,
  AlertTriangle,
} from "@lucide/vue";
import {
  statusLabels,
  type Actor,
  type AfterSalesCase,
  type Material,
  type Mode,
  type Policy,
  type Trace,
} from "../../shared/types";
import { api, money, time } from "./api";
import TracePanel from "./TracePanel.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { renderMarkdown } from "./markdown";
const props = defineProps<{
  item: AfterSalesCase;
  actor: Actor;
  policies: Policy[];
  aiReady: boolean;
}>();
const emit = defineEmits<{
  changed: [];
  error: [message: string];
  conversation: [id: string];
  busy: [value: boolean];
}>();
const busy = ref(false),
  note = ref(""),
  amount = ref(0),
  reason = ref(""),
  tab = ref("details"),
  materials = ref<Material[]>([]),
  traces = ref<Trace[]>([]),
  investigationMode = ref<Mode>("replay");
const confirmation = ref<{
  path: string;
  body: Record<string, unknown>;
  title: string;
  label: string;
  description: string;
} | null>(null);
const cancelReason = ref("");
const lastReview = computed(() => props.item.reviews.at(-1));
let detailsRequest = 0;
const validRevision = computed(
  () =>
    Number.isFinite(amount.value) &&
    amount.value > 0 &&
    amount.value <= props.item.paidCents / 100 &&
    reason.value.trim().length >= 3,
);
watch(busy, (value) => emit("busy", value));
onUnmounted(() => emit("busy", false));
watch(
  () => props.item.id,
  () => {
    note.value = "";
    confirmation.value = null;
    cancelReason.value = "";
  },
);
const editable = computed(
  () =>
    props.actor.role === "customer" &&
    ["waiting_review", "needs_materials"].includes(props.item.status),
);
watch(
  () => `${props.item.id}:${props.item.version}`,
  () => {
    amount.value = props.item.amountCents / 100;
    reason.value = props.item.reason;
  },
  { immediate: true },
);
watch(
  () => `${props.item.id}:${props.item.updatedAt}`,
  async () => {
    const request = ++detailsRequest,
      id = props.item.id;
    try {
      const [files, calls] = await Promise.all([
        api<Material[]>(`/cases/${id}/materials`),
        api<Trace[]>(`/cases/${id}/traces`),
      ]);
      if (request !== detailsRequest) return;
      materials.value = files;
      traces.value = calls;
    } catch (e) {
      emit("error", (e as Error).message);
    }
  },
  { immediate: true },
);
async function action(path: string, body: unknown = {}) {
  busy.value = true;
  try {
    await api(`/cases/${props.item.id}/${path}`, body);
    emit("changed");
  } catch (e) {
    emit("error", (e as Error).message);
    emit("changed");
  } finally {
    busy.value = false;
  }
}
function askReview(decision: "approve" | "revise" | "reject") {
  if (decision !== "approve" && note.value.trim().length < 3) {
    emit("error", "请写明退回或拒绝的原因，至少 3 个字");
    return;
  }
  const label = {
    approve: "确认批准并执行",
    revise: "确认退回补充",
    reject: "确认拒绝申请",
  }[decision];
  confirmation.value = {
    path: "review",
    body: { version: props.item.version, decision, note: note.value.trim() },
    title: label,
    label,
    description: `${props.item.number} · ${props.item.orderId} · v${props.item.version} · ${money(props.item.amountCents)}。 ${decision === "approve" ? "批准后将执行模拟退款，请核对金额与材料。" : note.value.trim()}`,
  };
}
function askCancel() {
  cancelReason.value = "";
  confirmation.value = {
    path: "cancel",
    body: { version: props.item.version },
    title: "撤回售后申请",
    label: "确认撤回",
    description:
      "撤回后本次申请停止处理，记录继续保留。需要再次申请时，请新建售后会话。",
  };
}
async function confirmAction() {
  const value = confirmation.value;
  if (!value) return;
  confirmation.value = null;
  await action(value.path, {
    ...value.body,
    ...(value.path === "cancel" ? { reason: cancelReason.value.trim() } : {}),
  });
}
const stage = computed(() =>
  props.item.status === "completed"
    ? 4
    : ["executing", "unknown", "approved"].includes(props.item.status)
      ? 3
      : props.item.status === "needs_materials"
        ? 1
        : 2,
);
</script>
<template>
  <div class="case-view">
    <header class="section-head">
      <div>
        <div class="eyebrow">售后申请 · {{ item.number }}</div>
        <h2>{{ item.product }}</h2>
      </div>
      <span class="status" :class="item.status">{{ statusLabels[item.status] }}</span>
    </header>
    <div v-if="!['rejected', 'cancelled'].includes(item.status)" class="process-strip">
      <div
        v-for="(label, i) in [
          '提交申请',
          '材料核对',
          '企业审批',
          '退款执行',
          '处理完成',
        ]"
        :key="label"
        :class="{ done: i < stage, current: i === stage }"
      >
        <Check v-if="i < stage" :size="15" /><span v-else>{{ i + 1 }}</span
        >{{ label }}
      </div>
    </div>
    <nav class="line-tabs">
      <button :class="{ active: tab === 'details' }" @click="tab = 'details'">
        申请详情</button
      ><button
        :class="{ active: tab === 'investigation' }"
        @click="tab = 'investigation'"
      >
        材料调查</button
      ><button :class="{ active: tab === 'trace' }" @click="tab = 'trace'">
        执行记录 <small>{{ traces.length }}</small></button
      ><a
        class="icon-button"
        :href="`/api/cases/${item.id}/report`"
        title="下载申请与执行报告"
        ><Download :size="17"
      /></a>
    </nav>
    <div class="case-scroll">
      <template v-if="tab === 'details'">
        <div v-if="item.status === 'cancelled'" class="notice">
          已撤回：{{ item.cancellationReason }}。本次申请不会执行退款。
        </div>
        <div
          v-if="['needs_materials', 'rejected'].includes(item.status) && lastReview"
          class="notice warning"
        >
          <div>
            <strong>{{ item.status === "rejected" ? "拒绝原因" : "需要补充" }}</strong>
            <p>{{ lastReview.note || "请联系审核人员核对具体要求" }}</p>
          </div>
        </div>
        <dl class="facts-grid">
          <div>
            <dt>订单号</dt>
            <dd>{{ item.orderId }}</dd>
          </div>
          <div>
            <dt>当前版本</dt>
            <dd>v{{ item.version }}</dd>
          </div>
          <div>
            <dt>订单实付</dt>
            <dd>{{ money(item.paidCents) }}</dd>
          </div>
          <div>
            <dt>申请退款</dt>
            <dd class="large-number">{{ money(item.amountCents) }}</dd>
          </div>
        </dl>
        <section class="content-section">
          <h3>问题描述</h3>
          <p class="preline">{{ item.reason }}</p>
        </section>
        <section class="content-section">
          <h3>
            已确认材料 <small>{{ materials.length }}</small>
          </h3>
          <div v-for="m in materials" :key="m.id" class="material-inline">
            <img
              v-if="m.kind === 'image'"
              :src="`/api/materials/${m.id}/content`"
              :alt="m.name"
            />
            <div>
              <strong>{{ m.name }}</strong>
              <p>{{ m.observation }}</p>
              <span class="minor-tag">{{
                m.confirmed ? "用户已核对" : "等待核对"
              }}</span>
              <a
                class="text-button"
                :href="`/api/materials/${m.id}/content`"
                target="_blank"
                rel="noopener"
                >查看原文件</a
              >
            </div>
          </div>
        </section>
        <section class="content-section">
          <h3>处理依据</h3>
          <details
            v-for="p in item.policySnapshots ??
            policies.filter((p) => item.sourceIds.includes(p.id))"
            :key="p.id"
            class="source"
          >
            <summary>
              {{ p.title }} <small>v{{ p.version }} · {{ p.id }}</small>
            </summary>
            <p>{{ p.content }}</p>
            <small>{{ p.source }}</small>
          </details>
        </section>
        <section v-if="item.refund" class="receipt">
          <CircleCheck :size="24" />
          <div>
            <h3>模拟退款已完成</h3>
            <p>{{ money(item.refund.amountCents) }} · {{ item.refund.id }}</p>
            <small
              >业务回执：{{ item.refund.requestKey }}<br />{{
                time(item.refund.at)
              }}</small
            >
          </div>
        </section>
        <section v-if="item.lastError" class="notice warning">
          <AlertTriangle :size="20" />
          <div>
            <strong>执行结果需要核对</strong>
            <p>{{ item.lastError }}</p>
          </div>
        </section>
        <button
          v-if="['unknown', 'approved', 'executing'].includes(item.status)"
          class="primary"
          :disabled="busy || item.attempts >= 5"
          @click="action('retry')"
        >
          <RotateCcw :size="17" />核对结果并继续
        </button>
        <p
          v-if="item.status === 'unknown' && item.attempts >= 5"
          class="notice warning"
        >
          已达到 5 次执行上限，请人工核对业务回执。
        </p>
        <section v-if="editable" class="content-section">
          <h3>修改申请</h3>
          <button
            class="text-button"
            @click="emit('conversation', item.conversationId)"
          >
            返回原会话补充材料 <ArrowRight :size="14" />
          </button>
          <div class="form-row">
            <label
              >申请金额（元）<input
                v-model.number="amount"
                type="number"
                min="0.01"
                :max="item.paidCents / 100"
                step="0.01" /></label
            ><label class="grow"
              >问题说明<textarea v-model="reason" rows="2" maxlength="1500" />
            </label>
          </div>
          <button
            class="secondary"
            :disabled="busy || !validRevision"
            @click="
              action('revise', {
                version: item.version,
                amountCents: Math.round(amount * 100),
                reason,
              })
            "
          >
            <RotateCcw :size="16" />确认修改并重新送审
          </button>
          <button class="danger-link" :disabled="busy" @click="askCancel">
            撤回申请
          </button>
        </section>
        <section
          v-if="actor.role === 'reviewer' && item.status === 'waiting_review'"
          class="review-section"
        >
          <h3><ShieldCheck :size="18" />审核当前申请 · v{{ item.version }}</h3>
          <textarea
            v-model="note"
            placeholder="填写审核意见或需要补充的材料"
            rows="3"
            maxlength="1000"
          />
          <div class="actions">
            <button class="primary" :disabled="busy" @click="askReview('approve')">
              <Check :size="17" />{{ busy ? "处理中…" : "批准并执行" }}</button
            ><button
              class="secondary"
              :disabled="busy || note.trim().length < 3"
              @click="askReview('revise')"
            >
              <RotateCcw :size="17" />退回补充</button
            ><button
              class="danger-link"
              :disabled="busy || note.trim().length < 3"
              @click="askReview('reject')"
            >
              <X :size="17" />拒绝申请
            </button>
          </div>
        </section>
        <section class="content-section">
          <h3>处理记录</h3>
          <div v-for="entry in item.history || []" :key="entry.id" class="history-line">
            <Clock :size="15" />
            <div class="history-entry">
              <p>
                {{ entry.action }} · v{{ entry.version
                }}<small>{{ time(entry.at) }}</small>
              </p>
              <p>{{ entry.actorName }} · {{ entry.note }}</p>
              <details>
                <summary>查看当时确认的内容</summary>
                <p>{{ money(entry.amountCents) }} · {{ entry.reason }}</p>
                <p v-for="m in entry.materials" :key="m.id">
                  {{ m.name }}：{{ m.observation }}
                </p>
              </details>
            </div>
          </div>
          <div v-if="!item.history?.length" class="history-line">
            <Clock :size="15" />
            <p>
              客户确认申请 <small>{{ time(item.createdAt) }}</small>
            </p>
          </div>
          <div
            v-for="r in item.history?.length ? [] : item.reviews"
            :key="r.id"
            class="history-line"
          >
            <ShieldCheck :size="15" />
            <p>
              {{ { approve: "批准", revise: "退回补充", reject: "拒绝" }[r.decision] }}
              v{{ r.version }} · {{ r.note || "无附加意见"
              }}<small>{{ time(r.at) }}</small>
            </p>
          </div>
          <div v-if="item.refund" class="history-line">
            <Check :size="15" />
            <p>
              退款回执已核对 <small>{{ time(item.refund.at) }}</small>
            </p>
          </div>
        </section>
      </template>
      <template v-else-if="tab === 'investigation'">
        <div class="section-intro">
          <h3>核对沟通与检测材料</h3>
          <p>
            本次调查包含两份明确标注的演示资料，以及申请中的已确认材料。结论交给审核人员参考。
          </p>
        </div>
        <div class="actions">
          <select v-model="investigationMode">
            <option value="replay">Replay 预设核对</option>
            <option value="ai" :disabled="!aiReady">AI 角色协作</option></select
          ><button
            class="primary"
            :disabled="busy"
            @click="action('investigate', { mode: investigationMode })"
          >
            <FileSearch :size="17" />{{ busy ? "正在核对材料…" : "开始材料调查" }}
          </button>
        </div>
        <div v-if="item.investigation" class="investigation-result">
          <p
            v-if="
              item.investigation.status === 'stale' ||
              item.investigation.caseVersion !== item.version
            "
            class="notice warning"
          >
            这份报告对应旧版申请{{
              item.investigation.caseVersion
                ? ` v${item.investigation.caseVersion}`
                : "（版本未记录）"
            }}，当前为 v{{ item.version }}。请重新调查，以下内容仅供历史核对。
          </p>
          <p v-else class="muted">
            核对申请 v{{ item.investigation.caseVersion }} ·
            {{ item.investigation.at }}
          </p>
          <p v-if="item.investigation.error" class="notice warning">
            {{ item.investigation.error }}
          </p>
          <template v-else
            ><h3>事实与政策核对</h3>
            <div
              v-for="(f, i) in [
                ...item.investigation.facts,
                ...item.investigation.policies,
              ]"
              :key="i"
              class="finding"
            >
              <small>{{ f.file }}</small>
              <blockquote>{{ f.quote }}</blockquote>
              <div
                class="markdown-body finding-text"
                v-html="renderMarkdown(f.finding)"
              ></div>
            </div>
            <h3>需要人工核对</h3>
            <ul>
              <li v-for="u in item.investigation.unresolved" :key="u">
                {{ u }}
              </li>
            </ul>
            <div
              class="markdown-body investigation-summary"
              v-html="renderMarkdown(item.investigation.summary)"
            ></div>
            <details>
              <summary>交付文件</summary>
              <pre>{{ item.investigation.files.join("\n") }}</pre>
            </details></template
          >
        </div>
      </template>
      <TracePanel v-else :items="traces" />
    </div>
    <ConfirmDialog
      :open="!!confirmation"
      :title="confirmation?.title || ''"
      :confirm-label="confirmation?.label || ''"
      :danger="
        confirmation?.path === 'cancel' || confirmation?.body.decision === 'reject'
      "
      :disabled="confirmation?.path === 'cancel' && cancelReason.trim().length < 3"
      @cancel="confirmation = null"
      @confirm="confirmAction"
    >
      <p>{{ confirmation?.description }}</p>
      <label v-if="confirmation?.path === 'cancel'"
        >撤回原因<textarea v-model="cancelReason" rows="3" maxlength="500" />
      </label>
    </ConfirmDialog>
  </div>
</template>

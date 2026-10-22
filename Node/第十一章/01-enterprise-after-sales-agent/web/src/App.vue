<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ArrowUp,
  Plus,
  MessageSquare,
  ClipboardList,
  Headphones,
  ImagePlus,
  Mic,
  Square,
  Paperclip,
  ChevronRight,
  CircleCheck,
  Settings2,
  X,
  RefreshCw,
  Activity,
  FlaskConical,
  LoaderCircle,
  Check,
  Trash2,
  Pencil,
  ChevronLeft,
  Search,
  Bell,
} from "@lucide/vue";
import type {
  Bootstrap,
  Conversation,
  ConversationSummary,
  EvaluationReport,
  Material,
  Mode,
  AfterSalesCase,
  Trace,
  CasePage,
} from "../../shared/types";
import { statusLabels } from "../../shared/types";
import { api, ApiError, money, time } from "./api";
import { useConversations } from "./composables/useConversations";
import { useVoiceInput } from "./composables/useVoiceInput";
import ChatTranscript from "./ChatTranscript.vue";
import ProposalPanel from "./ProposalPanel.vue";
import CaseView from "./CaseView.vue";
import TracePanel from "./TracePanel.vue";
import EvaluationView from "./EvaluationView.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

const data = ref<Bootstrap | null>(null),
  view = ref("chat"),
  conversationId = ref(""),
  caseId = ref(""),
  mode = ref<Mode>("replay"),
  message = ref(""),
  busy = ref(false),
  error = ref(""),
  rightTab = ref("proposal"),
  materialList = ref<Material[]>([]),
  traces = ref<Trace[]>([]),
  amount = ref(3500),
  reason = ref(""),
  accepted = ref(false),
  fault = ref("none"),
  profileOpen = ref(false),
  preference = ref(""),
  uploadInput = ref<HTMLInputElement | null>(null),
  chatBody = ref<InstanceType<typeof ChatTranscript> | null>(null),
  judgeResult = ref<{
    passed: boolean;
    reason: string;
    quotes: string[];
  } | null>(null);
const connected = ref(false),
  expired = ref(false),
  initialLoading = ref(true);
const {
  conversations,
  conversation,
  loadConversations,
  loadConversation,
  resetConversations,
  sendMessage,
  sendingText,
  streamingAnswer,
  streamStatus,
} = useConversations(() => {
  chatBody.value?.scrollToBottom();
});
const activeCase = ref<AfterSalesCase>();
const evaluations = ref<EvaluationReport[]>([]);
const speechBusy = ref(false);
function stopPlayback() {
  chatBody.value?.stopPlayback();
}
const { recording, voiceBusy, toggleRecording, stopVoice } = useVoiceInput({
  message,
  enabled: () => !!data.value?.multimodalReady,
  beforeStart: stopPlayback,
  onError: fail,
  onSuccess: notifySuccess,
});
const lastAccount = ref(sessionStorage.getItem("af-last-account") || "lin");
const childBusy = ref(false),
  removeTarget = ref<Material | null>(null);
const materialVersion = ref<number | undefined>(),
  removeVersion = ref<number | undefined>();
const renameTarget = ref<ConversationSummary | Conversation | null>(null),
  newTitle = ref("");
const deleteTarget = ref<ConversationSummary | Conversation | null>(null),
  conversationQuery = ref(""),
  success = ref(""),
  dialogError = ref(""),
  forgetOpen = ref(false);
let successTimer: ReturnType<typeof setTimeout> | undefined;
const caseQuery = ref(""),
  caseStatus = ref(""),
  caseSort = ref("updated");
type ConversationFilter = "all" | "open" | "resolved";
const conversationFilter = ref<ConversationFilter>("all");
const casePage = ref<CasePage>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  counts: {},
});
const caseLoading = ref(false);
let listRequest = 0,
  detailsRequest = 0,
  accountEpoch = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const locked = computed(
  () =>
    busy.value ||
    childBusy.value ||
    recording.value ||
    voiceBusy.value ||
    speechBusy.value,
);
const materialEditable = computed(
  () =>
    !activeCase.value ||
    ["waiting_review", "needs_materials"].includes(activeCase.value.status),
);
const validApplication = computed(
  () =>
    Number.isFinite(amount.value) &&
    amount.value > 0 &&
    amount.value <= (proposal.value?.amountCents || 0) / 100 &&
    reason.value.trim().length >= 3,
);
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
const resolved = (c: ConversationSummary) =>
  !!c.caseStatus && ["completed", "rejected", "cancelled"].includes(c.caseStatus);
const filteredConversations = computed(() => {
  const query = conversationQuery.value.trim().toLocaleLowerCase();
  return conversations.value.filter(
    (c) =>
      c.title.toLocaleLowerCase().includes(query) &&
      (conversationFilter.value === "all" ||
        (conversationFilter.value === "resolved" ? resolved(c) : !resolved(c))),
  );
});
const conversationCounts = computed(() => {
  const count = conversations.value.filter(resolved).length;
  return {
    all: conversations.value.length,
    resolved: count,
    open: conversations.value.length - count,
  };
});
const selectedCase = computed(() =>
  casePage.value.items.find((c) => c.id === caseId.value),
);
const proposal = computed(() => conversation.value?.proposal);
const photoReady = computed(() =>
  materialList.value.some((m) => m.kind === "image" && m.confirmed),
);
const pending = computed(() => casePage.value.counts.waiting_review || 0);
const missing = computed(() => {
  const items = proposal.value?.missing.filter((m) => !m.includes("照片")) || [];
  if (proposal.value && !photoReady.value) items.push("损坏照片与确认说明");
  return items;
});
const sourceList = computed(
  () =>
    conversation.value?.evidence ??
    data.value?.policies.filter((p) => proposal.value?.sourceIds.includes(p.id)) ??
    [],
);

function fail(e: unknown) {
  error.value = (e as Error).message || String(e);
  if (e instanceof ApiError && e.status === 401) {
    expired.value = true;
    connected.value = false;
  }
}
function notifySuccess(text: string) {
  error.value = "";
  success.value = text;
  clearTimeout(successTimer);
  successTimer = setTimeout(() => (success.value = ""), 4000);
}
function failDialog(e: unknown) {
  fail(e);
  dialogError.value = error.value;
}
function openRename(c: ConversationSummary | Conversation) {
  newTitle.value = c.title;
  dialogError.value = "";
  renameTarget.value = c;
}
function openDelete(c: ConversationSummary) {
  dialogError.value = "";
  deleteTarget.value = c;
}
async function loadCases(page = casePage.value.page, selectFirst = false) {
  if (!data.value || expired.value) return;
  const request = ++listRequest;
  caseLoading.value = true;
  try {
    const params = new URLSearchParams({
      query: caseQuery.value,
      sort: caseSort.value,
      page: String(page),
      pageSize: "20",
    });
    if (caseStatus.value) params.set("status", caseStatus.value);
    const result = await api<CasePage>(`/cases?${params}`);
    if (request !== listRequest) return;
    casePage.value = result;
    if (selectFirst || !caseId.value) caseId.value = result.items[0]?.id || "";
  } catch (e) {
    if (request === listRequest) fail(e);
  } finally {
    if (request === listRequest) caseLoading.value = false;
  }
}
async function refresh() {
  const epoch = accountEpoch;
  try {
    const result = await api<Bootstrap>("/bootstrap");
    if (epoch !== accountEpoch) return;
    data.value = result;
    lastAccount.value = result.actor.id;
    sessionStorage.setItem("af-last-account", result.actor.id);
    connected.value = true;
    expired.value = false;
    await loadConversations();
    if (view.value === "cases" || result.actor.role === "reviewer") await loadCases();
    if (view.value === "evaluation") await loadEvaluations();
  } catch (e) {
    if (epoch !== accountEpoch) return;
    connected.value = false;
    if (e instanceof ApiError && e.status === 401) expired.value = true;
    throw e;
  }
}
async function reconnect() {
  try {
    await refresh();
    error.value = "";
    await details();
  } catch (e) {
    fail(e);
  }
}
async function login(id: string) {
  busy.value = true;
  stopVoice();
  resetConversations();
  activeCase.value = undefined;
  evaluations.value = [];
  accountEpoch++;
  listRequest++;
  detailsRequest++;
  try {
    await api("/login", { accountId: id });
    lastAccount.value = id;
    sessionStorage.setItem("af-last-account", id);
    expired.value = false;
    conversationId.value = "";
    caseId.value = "";
    message.value = "";
    error.value = "";
    profileOpen.value = false;
    renameTarget.value = null;
    deleteTarget.value = null;
    forgetOpen.value = false;
    conversationQuery.value = "";
    success.value = "";
    dialogError.value = "";
    materialList.value = [];
    traces.value = [];
    judgeResult.value = null;
    accepted.value = false;
    fault.value = "none";
    stopPlayback();
    caseQuery.value = "";
    caseStatus.value = "";
    caseSort.value = "updated";
    casePage.value = { items: [], total: 0, page: 1, pageSize: 20, counts: {} };
    await refresh();
    view.value = data.value?.actor.role === "reviewer" ? "cases" : "chat";
    conversationId.value = conversations.value[0]?.id || "";
    await details();
    mode.value = conversation.value?.mode || "replay";
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function newConversation() {
  if (locked.value) return;
  busy.value = true;
  try {
    const c = await api<Conversation>("/conversations", { mode: mode.value });
    await refresh();
    conversationId.value = c.id;
    conversationQuery.value = "";
    stopPlayback();
    view.value = "chat";
    message.value = "";
    accepted.value = false;
    await details();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function details() {
  const request = ++detailsRequest;
  const id = conversationId.value;
  judgeResult.value = null;
  if (conversation.value?.id !== id) {
    activeCase.value = undefined;
    materialList.value = [];
    traces.value = [];
  }
  if (!conversationId.value) {
    materialList.value = [];
    traces.value = [];
    activeCase.value = undefined;
    await loadConversation("");
    return;
  }
  try {
    await loadConversation(id);
    if (request !== detailsRequest || id !== conversationId.value) return;
    const caseId = conversation.value?.caseId;
    const [materials, calls, item] = await Promise.all([
      api<Material[]>(`/conversations/${id}/materials`),
      api<Trace[]>(`/conversations/${id}/traces`),
      caseId ? api<AfterSalesCase>(`/cases/${caseId}`) : Promise.resolve(undefined),
    ]);
    if (request !== detailsRequest || id !== conversationId.value) return;
    materialList.value = materials;
    traces.value = calls;
    activeCase.value = item;
    materialVersion.value = item?.version;
  } catch (e) {
    if (request === detailsRequest && id === conversationId.value) fail(e);
  }
  await nextTick();
  chatBody.value?.scrollToBottom();
}
async function selectConversation(c: ConversationSummary) {
  if (locked.value) return;
  busy.value = true;
  try {
    message.value = "";
    stopPlayback();
    accepted.value = false;
    conversationId.value = c.id;
    mode.value = c.mode;
    view.value = "chat";
    await details();
  } finally {
    busy.value = false;
  }
}
async function openCaseConversation(id: string) {
  if (locked.value) return;
  busy.value = true;
  try {
    const c = await api<Conversation>(`/conversations/${id}/restore`, {});
    await refresh();
    conversationQuery.value = "";
    message.value = "";
    accepted.value = false;
    stopPlayback();
    conversationId.value = c.id;
    mode.value = c.mode;
    view.value = "chat";
    rightTab.value = "materials";
    await details();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function deleteConversation() {
  const target = deleteTarget.value;
  if (!target || busy.value) return;
  busy.value = true;
  dialogError.value = "";
  try {
    await api(`/conversations/${target.id}/delete`, {});
    conversations.value = conversations.value.filter((c) => c.id !== target.id);
    deleteTarget.value = null;
    if (conversationId.value === target.id) {
      detailsRequest++;
      stopPlayback();
      message.value = "";
      accepted.value = false;
      materialList.value = [];
      traces.value = [];
      judgeResult.value = null;
      const next = filteredConversations.value[0] || conversations.value[0];
      if (!filteredConversations.value.length) conversationQuery.value = "";
      conversationId.value = next?.id || "";
      mode.value = next?.mode || "replay";
      rightTab.value = "proposal";
      await details();
    }
    notifySuccess("会话已删除");
    await refresh();
  } catch (e) {
    failDialog(e);
  } finally {
    busy.value = false;
  }
}
/** 发送消息；首次发送时创建会话，出错时恢复输入并尝试刷新页面数据。 */
async function send(text = message.value) {
  // 不发送空白消息；处理期间阻止重复提交。
  if (!text.trim() || busy.value) return;

  // 标记为处理中，并清除上一次的错误信息。
  busy.value = true;
  error.value = "";

  try {
    // 尚无会话时，先按当前模式创建会话，保存返回的会话 ID。
    if (!conversationId.value) {
      const c = await api<Conversation>("/conversations", { mode: mode.value });
      conversationId.value = c.id;
    }

    // 清空输入框；待发送内容已保存在 text 中，不受清空操作影响。
    message.value = "";
    await sendMessage(conversationId.value, text);

    // 发送完成后，依次刷新数据和会话详情。
    await refresh();
    await details();
  } catch (e) {
    // 创建会话、发送消息或后续刷新出错时，处理异常并恢复输入内容。
    fail(e);
    message.value = text;

    // 尝试重新同步页面数据：refresh 成功后再执行 details。
    // 忽略这次补充刷新过程中产生的异常。
    await refresh()
      .then(details)
      .catch(() => {});
  } finally {
    // 无论成功还是失败，最后都解除处理中状态。
    busy.value = false;
  }
}
async function sample() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (!conversationId.value) {
      const c = await api<Conversation>("/conversations", { mode: mode.value });
      conversationId.value = c.id;
      await refresh();
    }
    await api(`/conversations/${conversationId.value}/sample`, {});
    await refresh();
    rightTab.value = "materials";
    await details();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024 || !file.size) {
    fail(new Error("材料不能为空，大小不能超过 5 MiB"));
    (event.target as HTMLInputElement).value = "";
    return;
  }
  busy.value = true;
  try {
    if (!conversationId.value) {
      const c = await api<Conversation>("/conversations", { mode: mode.value });
      conversationId.value = c.id;
      await refresh();
    }
    const body = new FormData();
    body.append("file", file);
    await api(`/conversations/${conversationId.value}/materials`, body);
    await refresh();
    rightTab.value = "materials";
    await details();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
    (event.target as HTMLInputElement).value = "";
  }
}
async function confirmMaterial(m: Material) {
  busy.value = true;
  try {
    await api(`/materials/${m.id}/confirm`, {
      observation: m.observation,
      version: materialVersion.value,
    });
    await refresh();
    await details();
    rightTab.value = "proposal";
    notifySuccess("材料说明已确认");
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function removeMaterial() {
  const target = removeTarget.value;
  if (!target || busy.value) return;
  busy.value = true;
  dialogError.value = "";
  try {
    await api(`/materials/${target.id}/remove`, {
      version: removeVersion.value,
    });
    accepted.value = false;
    removeTarget.value = null;
    await refresh();
    await details();
    notifySuccess("材料已移除");
  } catch (e) {
    failDialog(e);
  } finally {
    busy.value = false;
  }
}
async function renameConversation() {
  const target = renameTarget.value;
  if (!target || busy.value || !newTitle.value.trim()) return;
  busy.value = true;
  dialogError.value = "";
  try {
    await api(`/conversations/${target.id}/rename`, {
      title: newTitle.value,
    });
    renameTarget.value = null;
    await refresh();
    if (conversationId.value === target.id) await details();
    notifySuccess("会话名称已保存");
  } catch (e) {
    failDialog(e);
  } finally {
    busy.value = false;
  }
}
function handleEnter(event: KeyboardEvent) {
  if (
    event.isComposing ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return;
  event.preventDefault();
  void send();
}
function updateGlobalSearch(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (view.value === "chat") conversationQuery.value = value;
  else if (view.value === "cases") caseQuery.value = value;
}
function showCase(id: string) {
  caseQuery.value = "";
  caseStatus.value = "";
  casePage.value.page = 1;
  caseId.value = id;
  view.value = "cases";
}
async function submit() {
  busy.value = true;
  try {
    const item = await api<AfterSalesCase>(
      `/conversations/${conversationId.value}/submit`,
      {
        orderId: proposal.value?.order.id,
        draftVersion: conversation.value?.draftVersion ?? 0,
        amountCents: Math.round(amount.value * 100),
        reason: reason.value,
        fault: fault.value,
      },
    );
    showCase(item.id);
    await refresh();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function savePreference(forget = false) {
  if (busy.value) return;
  busy.value = true;
  dialogError.value = "";
  try {
    await api(
      forget ? "/preferences/forget" : "/preferences",
      forget ? {} : { value: preference.value },
    );
    await refresh();
    forgetOpen.value = false;
    profileOpen.value = false;
    notifySuccess(forget ? "偏好已删除，已停止自动记忆" : "沟通偏好已保存");
  } catch (e) {
    failDialog(e);
  } finally {
    busy.value = false;
  }
}
async function judge() {
  busy.value = true;
  try {
    judgeResult.value = await api(`/conversations/${conversationId.value}/judge`, {});
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
/** 报告只在进入评测页或本次评测完成后读取。 */
async function loadEvaluations() {
  const epoch = accountEpoch;
  const result = await api<EvaluationReport[]>("/evaluations");
  if (epoch === accountEpoch) evaluations.value = result;
}
watch(view, () => {
  stopVoice();
  stopPlayback();
  if (view.value === "cases") void loadCases();
  if (view.value === "evaluation") void loadEvaluations().catch(fail);
});
watch(
  () => `${conversation.value?.id}:${proposal.value?.order.id}`,
  () => {
    amount.value = (proposal.value?.amountCents || 350000) / 100;
    reason.value = proposal.value?.reason || "";
    accepted.value = false;
  },
);
watch([caseQuery, caseStatus, caseSort], () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadCases(1, true), 250);
});
watch(
  [
    amount,
    reason,
    () => conversation.value?.draftVersion,
    () =>
      JSON.stringify(
        materialList.value.map((m) => [m.id, m.confirmed, m.observation, m.orderId]),
      ),
  ],
  () => {
    accepted.value = false;
  },
);
onMounted(async () => {
  try {
    await refresh();
    view.value = data.value?.actor.role === "reviewer" ? "cases" : "chat";
    conversationId.value = conversations.value[0]?.id || "";
    await details();
    mode.value = conversation.value?.mode || "replay";
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.status === 401 &&
      !sessionStorage.getItem("af-last-account")
    )
      await login("lin");
    else fail(e);
  } finally {
    initialLoading.value = false;
  }
  timer = setInterval(async () => {
    if (
      locked.value ||
      expired.value ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")
    )
      return;
    if (polling || document.hidden) return;
    polling = true;
    const epoch = accountEpoch;
    const selected = conversationId.value;
    try {
      if (view.value === "cases") await loadCases();
      else if (
        view.value === "chat" &&
        activeCase.value &&
        !["completed", "rejected", "cancelled"].includes(activeCase.value.status)
      ) {
        const item = await api<AfterSalesCase>(`/cases/${activeCase.value.id}`);
        if (epoch !== accountEpoch || selected !== conversationId.value) return;
        if (item.updatedAt !== activeCase.value?.updatedAt) {
          activeCase.value = item;
          await loadConversations();
          await details();
        }
      }
    } catch (error) {
      if (epoch === accountEpoch) fail(error);
    } finally {
      polling = false;
    }
  }, 4000);
});
onUnmounted(() => {
  clearTimeout(successTimer);
  clearTimeout(searchTimer);
  if (timer) clearInterval(timer);
  stopVoice();
  stopPlayback();
});
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <a class="brand" href="/" aria-label="星河售后首页"
        ><span class="brand-mark"><Headphones :size="22" /></span
        ><span>星河售后<small>服务工作台</small></span></a
      >
      <nav class="topnav">
        <button
          v-if="data?.actor.role === 'customer'"
          :class="{ active: view === 'chat' }"
          :disabled="locked"
          @click="view = 'chat'"
        >
          <MessageSquare :size="17" />售后沟通</button
        ><button
          :class="{ active: view === 'cases' }"
          :disabled="locked"
          @click="view = 'cases'"
        >
          <ClipboardList :size="17" />{{
            data?.actor.role === "reviewer" ? "审核工作台" : "我的申请"
          }}<span v-if="pending" class="count">{{ pending }}</span></button
        ><button
          v-if="data?.actor.role === 'reviewer'"
          :class="{ active: view === 'evaluation' }"
          :disabled="locked"
          @click="view = 'evaluation'"
        >
          <FlaskConical :size="17" />质量验证
        </button>
      </nav>
      <div class="top-right">
        <label v-if="view !== 'evaluation'" class="global-search">
          <Search :size="15" /><input
            :value="view === 'chat' ? conversationQuery : caseQuery"
            :placeholder="
              view === 'chat' ? '搜索会话、订单或客户' : '搜索订单、申请号或商品'
            "
            aria-label="全局搜索"
            @input="updateGlobalSearch"
          />
        </label>
        <button class="icon-button notification-button" title="通知">
          <Bell :size="18" /><i></i>
        </button>
        <span class="demo-label">课程演示 · 模拟业务</span
        ><select
          aria-label="当前演示账号"
          :value="data?.actor.id || 'lin'"
          :disabled="locked"
          @change="login(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="account in data?.accounts || []"
            :key="account.id"
            :value="account.id"
          >
            {{ account.name }}
          </option>
        </select>
      </div>
    </header>
    <div v-if="error" class="error-toast" role="alert">
      <span>{{ error }}</span
      ><button class="icon-button" title="关闭提示" @click="error = ''">
        <X :size="17" />
      </button>
    </div>
    <div v-else-if="success" class="success-toast" role="status">
      <CircleCheck :size="18" /><span>{{ success }}</span>
      <button class="icon-button" title="关闭成功提示" @click="success = ''">
        <X :size="17" />
      </button>
    </div>
    <div v-if="!connected && !initialLoading" class="connection-banner" role="status">
      <span>{{
        expired
          ? "登录已过期，请重新进入当前账号。"
          : "服务连接中断，当前显示的是上次读取的记录。"
      }}</span>
      <button
        class="text-button"
        @click="expired ? login(data?.actor.id || lastAccount) : reconnect()"
      >
        {{ expired ? "重新登录" : "重新连接" }}
      </button>
    </div>
    <main
      v-if="data"
      :inert="expired"
      class="app-main"
      :class="{ wide: view === 'evaluation' }"
    >
      <aside v-if="view !== 'evaluation'" class="sidebar">
        <template v-if="view === 'chat'"
          ><div class="sidebar-top">
            <span class="eyebrow">服务会话</span
            ><button
              class="icon-button"
              title="新建会话"
              :disabled="locked"
              @click="newConversation"
            >
              <Plus :size="19" />
            </button>
          </div>
          <div class="conversation-search">
            <label class="search-input">
              <Search :size="15" /><input
                v-model="conversationQuery"
                aria-label="搜索会话"
                placeholder="搜索会话名称"
                maxlength="50"
                :disabled="locked"
              />
              <button
                v-if="conversationQuery"
                class="icon-button"
                title="清空会话搜索"
                :disabled="locked"
                @click="conversationQuery = ''"
              >
                <X :size="14" />
              </button>
            </label>
          </div>
          <nav class="conversation-filters" aria-label="会话状态">
            <button
              :class="{ active: conversationFilter === 'all' }"
              @click="conversationFilter = 'all'"
            >
              全部 <span>{{ conversationCounts.all }}</span>
            </button>
            <button
              :class="{ active: conversationFilter === 'open' }"
              @click="conversationFilter = 'open'"
            >
              待处理 <span>{{ conversationCounts.open }}</span>
            </button>
            <button
              :class="{ active: conversationFilter === 'resolved' }"
              @click="conversationFilter = 'resolved'"
            >
              已解决 <span>{{ conversationCounts.resolved }}</span>
            </button>
          </nav>
          <div class="sidebar-scroll">
            <div
              v-for="c in filteredConversations"
              :key="c.id"
              class="conversation-item"
              :class="{ active: c.id === conversationId }"
            >
              <button
                class="conversation-select"
                :disabled="locked"
                :aria-pressed="c.id === conversationId"
                :title="c.title"
                @click="selectConversation(c)"
              >
                <MessageSquare :size="16" />
                <span>
                  <strong>{{ c.title }}</strong
                  ><small
                    >{{ time(c.updatedAt) }} ·
                    {{ c.mode === "ai" ? "AI" : "Replay" }}</small
                  >
                </span>
              </button>
              <div class="conversation-actions">
                <button
                  class="icon-button"
                  :title="`重命名：${c.title}`"
                  :disabled="locked"
                  @click="openRename(c)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  class="icon-button delete-conversation"
                  :title="`删除会话：${c.title}`"
                  :disabled="locked"
                  @click="openDelete(c)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
            <p v-if="!conversations.length" class="empty-small">
              暂无会话。点击右上角的「+」或直接发送消息。
            </p>
            <p v-else-if="!filteredConversations.length" class="empty-small">
              没有找到匹配的会话。
            </p>
            <div class="sidebar-caption">
              我的订单 <span>{{ data.orders.length }}</span>
            </div>
            <button
              v-for="o in data.orders"
              :key="o.id"
              class="order-item"
              :disabled="locked"
              @click="message = `请核对 ${o.id} 的订单和售后政策`"
            >
              <img
                v-if="o.id === 'A1024'"
                src="/coffee-machine.png"
                alt="星河 C7 咖啡机"
              /><span v-else class="order-symbol"><Paperclip :size="21" /></span>
              <div>
                <strong>{{ o.product }}</strong
                ><small>{{ o.id }} · {{ money(o.paidCents) }}</small>
              </div>
              <ChevronRight :size="14" />
            </button>
          </div>
          <button
            class="profile-button"
            :disabled="locked"
            @click="
              dialogError = '';
              preference = data.preferences.find((p) => !p.blocked)?.value || '';
              profileOpen = true;
            "
          >
            <Settings2 :size="17" /><span>沟通偏好</span
            ><small>{{
              data.preferences[0]?.blocked ? "已停用自动记忆" : "跨会话保存"
            }}</small>
          </button></template
        >
        <template v-else
          ><div class="sidebar-top">
            <span class="eyebrow">{{
              data.actor.role === "reviewer" ? "企业申请列表" : "我的售后申请"
            }}</span
            ><button
              class="icon-button"
              title="刷新申请"
              :disabled="locked || caseLoading"
              @click="reconnect"
            >
              <RefreshCw :size="16" />
            </button>
          </div>
          <div class="case-filters">
            <label class="search-input"
              ><Search :size="15" /><input
                v-model="caseQuery"
                aria-label="搜索申请"
                placeholder="订单、申请号或商品"
                maxlength="100"
                :disabled="locked" /><button
                v-if="caseQuery"
                class="icon-button"
                title="清空申请搜索"
                :disabled="locked"
                @click="caseQuery = ''"
              >
                <X :size="14" /></button
            ></label>
            <div class="filter-row">
              <select v-model="caseStatus" aria-label="申请状态" :disabled="locked">
                <option value="">全部状态</option>
                <option
                  v-for="(label, value) in statusLabels"
                  :key="value"
                  :value="value"
                >
                  {{ label }}（{{ casePage.counts[value] || 0 }}）
                </option>
              </select>
              <select v-model="caseSort" aria-label="申请排序" :disabled="locked">
                <option value="updated">最近更新</option>
                <option value="oldest">最早提交</option>
              </select>
            </div>
            <small>{{
              caseLoading ? "正在查询…" : "共 " + casePage.total + " 条申请"
            }}</small>
          </div>
          <div class="sidebar-scroll">
            <button
              v-for="c in casePage.items"
              :key="c.id"
              class="case-item"
              :class="{ active: c.id === caseId }"
              :disabled="locked"
              @click="caseId = c.id"
            >
              <div>
                <strong>{{ c.orderId }}</strong
                ><span class="status tiny" :class="c.status">{{
                  statusLabels[c.status]
                }}</span>
              </div>
              <p>{{ c.product }}</p>
              <small
                >{{ money(c.amountCents) }} · v{{ c.version }} ·
                {{ time(c.updatedAt) }}</small
              >
            </button>
            <p v-if="!casePage.items.length" class="empty-small">
              {{ caseQuery || caseStatus ? "没有符合条件的申请。" : "暂无售后申请。" }}
            </p>
          </div>
          <div class="pagination">
            <button
              class="icon-button"
              title="上一页申请"
              :disabled="locked || caseLoading || casePage.page <= 1"
              @click="loadCases(casePage.page - 1, true)"
            >
              <ChevronLeft :size="16" />
            </button>
            <small
              >{{ casePage.page }} /
              {{ Math.max(1, Math.ceil(casePage.total / casePage.pageSize)) }}</small
            >
            <button
              class="icon-button"
              title="下一页申请"
              :disabled="
                locked ||
                caseLoading ||
                casePage.page * casePage.pageSize >= casePage.total
              "
              @click="loadCases(casePage.page + 1, true)"
            >
              <ChevronRight :size="16" />
            </button></div
        ></template>
        <div class="sidebar-footer">
          <span class="online-dot" :class="{ offline: !connected }" />{{
            connected ? "服务已连接" : "连接已断开"
          }}
          <span>{{ data.actor.tenantId === "xinghe" ? "星河零售" : "另一企业" }}</span>
        </div>
      </aside>
      <template v-if="view === 'chat'">
        <section class="chat-column">
          <header class="chat-header">
            <div>
              <div class="title-row">
                <img
                  v-if="proposal?.order.id === 'A1024'"
                  class="chat-order-thumb"
                  src="/coffee-machine.png"
                  alt="星河 C7 咖啡机"
                />
                <h1>{{ conversation?.title || "售后沟通" }}</h1>
                <button
                  v-if="conversation"
                  class="icon-button"
                  title="重命名会话"
                  :disabled="locked"
                  @click="openRename(conversation)"
                >
                  <Pencil :size="14" />
                </button>
                <span
                  v-if="activeCase"
                  class="status compact"
                  :class="activeCase.status"
                  >{{ statusLabels[activeCase.status] }}</span
                >
              </div>
              <small>{{
                conversation?.caseId
                  ? "已关联售后申请"
                  : "订单核对 · 政策依据 · 处理进度"
              }}</small>
            </div>
            <div class="mode-control">
              <span :class="mode === 'ai' ? 'green' : 'muted'">{{
                mode === "ai" ? "真实模型" : "预设演示"
              }}</span
              ><select
                v-model="mode"
                aria-label="运行模式"
                :disabled="busy"
                @change="newConversation"
              >
                <option value="replay">Replay 演示</option>
                <option value="ai" :disabled="!data.aiReady">AI · DeepSeek</option>
              </select>
            </div>
          </header>
          <ChatTranscript
            ref="chatBody"
            :actor="data.actor"
            :policies="data.policies"
            :multimodal-ready="data.multimodalReady"
            :conversation="conversation"
            :sending-text="sendingText"
            :streaming-answer="streamingAnswer"
            :stream-status="streamStatus"
            :judge-result="judgeResult"
            :busy="busy"
            :speech-disabled="recording || voiceBusy"
            @send="send"
            @sources="rightTab = 'proposal'"
            @error="fail"
            @busy="speechBusy = $event"
          />
          <div class="composer-area">
            <div v-if="activeCase" class="linked-case" @click="showCase(activeCase.id)">
              <ClipboardList :size="16" /><span
                >{{ activeCase.number }} · {{ statusLabels[activeCase.status] }}</span
              ><ChevronRight :size="15" />
            </div>
            <div class="composer">
              <textarea
                v-model="message"
                aria-label="售后问题"
                :placeholder="
                  recording
                    ? '正在听，边说边出字，说完点一下停止…'
                    : '描述问题，或继续补充订单与材料…'
                "
                rows="3"
                maxlength="2000"
                :disabled="recording || voiceBusy || busy"
                @keydown.enter="handleEnter"
              />
              <div class="composer-bottom">
                <div class="composer-tools">
                  <button
                    class="icon-button"
                    title="上传照片或文字材料"
                    :disabled="busy || !materialEditable || materialList.length >= 10"
                    @click="uploadInput?.click()"
                  >
                    <ImagePlus :size="19" /></button
                  ><button
                    class="icon-button"
                    :class="{ recording }"
                    :title="
                      voiceBusy
                        ? '取消语音识别'
                        : recording
                          ? '停止并生成文字'
                          : '语音输入'
                    "
                    :disabled="!data.multimodalReady || busy"
                    @click="toggleRecording"
                  >
                    <Square v-if="recording || voiceBusy" :size="18" /><Mic
                      v-else
                      :size="19"
                    /></button
                  ><button
                    class="sample-button"
                    :disabled="busy || !materialEditable || materialList.length >= 10"
                    @click="sample"
                  >
                    添加演示照片
                  </button>
                </div>
                <button
                  class="send-button"
                  title="发送消息"
                  :disabled="busy || !message.trim() || recording || voiceBusy"
                  @click="send()"
                >
                  <ArrowUp :size="20" />
                </button>
              </div>
            </div>
            <div class="composer-caption">
              <span>{{
                mode === "replay"
                  ? "Replay：预设决策，真实工具与业务记录"
                  : "AI：真实模型调用，操作仍需确认与审批"
              }}</span
              ><button
                v-if="data.aiReady && conversation?.messages.length"
                :disabled="busy"
                @click="judge"
              >
                评阅本次回答
              </button>
            </div>
          </div>
        </section>
        <aside class="context-column">
          <nav class="context-tabs">
            <button
              :class="{ active: rightTab === 'proposal' }"
              @click="rightTab = 'proposal'"
            >
              处理建议</button
            ><button
              :class="{ active: rightTab === 'materials' }"
              @click="rightTab = 'materials'"
            >
              材料 <small>{{ materialList.length }}</small></button
            ><button
              :class="{ active: rightTab === 'trace' }"
              @click="
                rightTab = 'trace';
                details();
              "
              title="查看本次实际调用"
            >
              <Activity :size="15" />轨迹
            </button>
          </nav>
          <div class="context-scroll">
            <ProposalPanel
              v-if="rightTab === 'proposal'"
              :proposal="proposal"
              :active-case="activeCase"
              :source-list="sourceList"
              :missing="missing"
              :photo-ready="photoReady"
              :valid-application="validApplication"
              :busy="busy"
              v-model:amount="amount"
              v-model:reason="reason"
              v-model:accepted="accepted"
              v-model:fault="fault"
              @materials="rightTab = 'materials'"
              @submit="submit"
              @case="showCase($event)"
            />
            <template v-else-if="rightTab === 'materials'"
              ><div class="context-heading">
                <Paperclip :size="20" />
                <h3>申请材料</h3>
              </div>
              <div class="actions">
                <button
                  class="secondary"
                  :disabled="busy || !materialEditable || materialList.length >= 10"
                  @click="uploadInput?.click()"
                >
                  <ImagePlus :size="16" />上传材料</button
                ><button
                  class="text-button"
                  :disabled="busy || !materialEditable || materialList.length >= 10"
                  @click="sample"
                >
                  演示照片
                </button>
              </div>
              <p class="muted small">
                PNG / JPEG、TXT / Markdown，单份不超过 5 MiB，最多 10 份。
              </p>
              <div v-for="m in materialList" :key="m.id" class="material-item">
                <img
                  v-if="m.kind === 'image'"
                  :src="`/api/materials/${m.id}/content`"
                  :alt="m.name"
                />
                <div class="material-title">
                  <strong>{{ m.name }}</strong
                  ><span v-if="m.confirmed" class="green"
                    ><Check :size="15" />已核对</span
                  >
                </div>
                <div class="material-actions">
                  <a
                    class="text-button"
                    :href="`/api/materials/${m.id}/content`"
                    target="_blank"
                    rel="noopener"
                    >查看原文件</a
                  >
                  <small>{{ (m.bytes / 1024).toFixed(1) }} KiB</small>
                  <button
                    class="icon-button danger-link"
                    :title="'移除材料 ' + m.name"
                    :disabled="busy || !materialEditable"
                    @click="
                      dialogError = '';
                      removeTarget = m;
                      removeVersion = materialVersion;
                    "
                  >
                    <Trash2 :size="16" />
                  </button>
                </div>
                <label
                  >材料说明<textarea
                    v-model="m.observation"
                    rows="4"
                    maxlength="2000"
                    :disabled="
                      !!activeCase &&
                      !['waiting_review', 'needs_materials'].includes(activeCase.status)
                    "
                  /></label
                ><button
                  class="secondary full"
                  :disabled="
                    busy ||
                    (!!activeCase &&
                      !['waiting_review', 'needs_materials'].includes(
                        activeCase.status,
                      ))
                  "
                  @click="confirmMaterial(m)"
                >
                  <CircleCheck :size="16" />{{
                    m.confirmed ? "保存核对说明" : "确认这份材料"
                  }}
                </button>
              </div>
              <p v-if="!materialList.length" class="empty-small">
                还没有上传材料。
              </p></template
            >
            <TracePanel v-else :items="traces" />
          </div>
        </aside>
      </template>
      <section v-else-if="view === 'cases'" class="case-column">
        <CaseView
          v-if="selectedCase"
          :key="selectedCase.id"
          :item="selectedCase"
          :actor="data.actor"
          :policies="data.policies"
          :ai-ready="data.aiReady"
          @changed="refresh"
          @error="error = $event"
          @busy="childBusy = $event"
          @conversation="openCaseConversation"
        />
        <div v-else class="empty-state">
          <ClipboardList :size="42" />
          <h2>暂无待处理申请</h2>
          <p>
            {{
              data.actor.role === "reviewer"
                ? "客户确认提交后，申请会出现在这里。"
                : "在售后沟通中核对订单与材料，再确认申请。"
            }}
          </p>
          <button
            v-if="data.actor.role === 'customer'"
            class="primary"
            @click="view = 'chat'"
          >
            开始售后沟通
          </button>
        </div>
      </section>
      <EvaluationView
        v-else
        :reports="evaluations"
        @busy="childBusy = $event"
        @changed="loadEvaluations"
        @error="error = $event"
      />
    </main>
    <div v-else class="loading-screen">
      <template v-if="initialLoading"
        ><LoaderCircle class="spin" :size="28" />正在连接售后服务…</template
      >
      <template v-else
        >暂时无法读取售后工作台<button class="secondary" @click="reconnect">
          重试连接
        </button></template
      >
    </div>
    <input
      ref="uploadInput"
      type="file"
      hidden
      accept="image/png,image/jpeg,.txt,.md"
      @change="upload"
    />
    <ConfirmDialog
      :open="!!removeTarget"
      title="移除这份材料"
      confirm-label="确认移除"
      danger
      :busy="busy"
      :error="dialogError"
      @cancel="removeTarget = null"
      @confirm="removeMaterial"
    >
      <p>{{ removeTarget?.name }}</p>
      <p>
        {{
          activeCase
            ? "材料变更后申请进入补充状态，需要重新确认送审。原有记录保留用于核对。"
            : "移除后，这份材料不再用于本次申请。"
        }}
      </p>
    </ConfirmDialog>
    <ConfirmDialog
      :open="!!renameTarget"
      title="重命名会话"
      confirm-label="保存名称"
      :disabled="!newTitle.trim()"
      :busy="busy"
      :error="dialogError"
      @cancel="renameTarget = null"
      @confirm="renameConversation"
    >
      <label>会话名称<input v-model="newTitle" maxlength="50" /></label>
    </ConfirmDialog>
    <ConfirmDialog
      :open="!!deleteTarget"
      title="删除这条会话？"
      confirm-label="确认删除"
      danger
      :busy="busy"
      :error="dialogError"
      @cancel="deleteTarget = null"
      @confirm="deleteConversation"
    >
      <p class="delete-title">{{ deleteTarget?.title }}</p>
      <p>删除后，这条记录将从会话列表移除。</p>
      <p v-if="deleteTarget?.caseId">
        已提交的售后申请、材料和处理记录仍会保留，申请不会被撤回。需要补充材料时，可从申请详情返回原会话。
      </p>
      <p v-else>删除会话不会删除已保存的沟通偏好。</p>
    </ConfirmDialog>
    <ConfirmDialog
      :open="profileOpen"
      title="沟通偏好"
      confirm-label="保存偏好"
      :disabled="!preference.trim()"
      :busy="busy"
      :error="forgetOpen ? '' : dialogError"
      @cancel="profileOpen = false"
      @confirm="savePreference()"
    >
      <p>设置后可在新的会话中继续使用。</p>
      <label
        >希望怎样沟通<input
          v-model="preference"
          placeholder="例如：优先使用文字沟通"
          maxlength="100"
      /></label>
      <div v-if="data?.preferences[0]?.blocked" class="notice">
        已停止自动保存。主动保存偏好后可以重新启用。
      </div>
      <button
        class="danger-link"
        :disabled="busy || data?.preferences[0]?.blocked"
        @click="
          dialogError = '';
          forgetOpen = true;
        "
      >
        <Trash2 :size="14" />删除偏好并停止自动记忆
      </button>
    </ConfirmDialog>
    <ConfirmDialog
      :open="forgetOpen"
      title="删除沟通偏好？"
      confirm-label="确认删除并停用"
      danger
      :busy="busy"
      :error="dialogError"
      @cancel="
        forgetOpen = false;
        dialogError = '';
      "
      @confirm="savePreference(true)"
    >
      <p>
        将删除已保存的沟通偏好，并停止自动记忆这项信息。聊天记录和售后申请不受影响。
      </p>
      <p>以后主动保存新的偏好，可以重新启用。</p>
    </ConfirmDialog>
  </div>
</template>

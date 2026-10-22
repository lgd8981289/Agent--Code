<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import {
  Headphones,
  ChevronRight,
  Check,
  Copy,
  FileText,
  Square,
  Volume2,
  LoaderCircle,
} from "@lucide/vue";
import type { Actor, Policy, Conversation } from "../../shared/types";
import { time } from "./api";
import { renderMarkdown } from "./markdown";
import { useSpeechPlayback } from "./composables/useSpeechPlayback";
const props = defineProps<{
  actor: Actor;
  policies: Policy[];
  multimodalReady: boolean;
  conversation?: Conversation;
  sendingText: string;
  streamingAnswer: string;
  streamStatus: string;
  busy: boolean;
  speechDisabled: boolean;
  judgeResult: { passed: boolean; reason: string; quotes: string[] } | null;
}>();
const emit = defineEmits<{
  send: [text: string];
  sources: [];
  error: [error: unknown];
  busy: [value: boolean];
}>();
const onError = (error: unknown) => emit("error", error);
const chatBody = ref<HTMLElement | null>(null),
  copied = ref("");
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const {
  speechPlayer,
  audioUrl,
  speechStatus,
  playingId,
  speechBusy,
  speak,
  stopPlayback,
  playbackError,
} = useSpeechPlayback(() => props.multimodalReady, onError);
watch(speechBusy, (value) => emit("busy", value));
watch(() => props.conversation?.id, stopPlayback);
onUnmounted(() => {
  clearTimeout(copyTimer);
  emit("busy", false);
});
function scrollToBottom() {
  if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
}
defineExpose({ scrollToBottom, stopPlayback });
async function copyMessage(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = id;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = ""), 2000);
  } catch {
    onError(new Error("复制失败，请选中文字后复制"));
  }
}
</script>
<template>
  <div ref="chatBody" class="chat-scroll">
    <div v-if="!conversation?.messages.length && !sendingText" class="welcome">
      <div class="welcome-image">
        <img src="/coffee-machine.png" alt="咖啡机损坏演示材料" /><span
          >到货损坏 · 演示样本</span
        >
      </div>
      <div class="eyebrow">星河售后助手</div>
      <h2>说说遇到了什么问题</h2>
      <p>核对订单与售后政策，协助你完成申请。</p>
      <div class="starter-list">
        <button
          :disabled="busy"
          @click="
            emit('send', 'A1024 咖啡机刚收到，外壳裂了，实付 3500 元，我想申请退款。')
          "
        >
          <span>咖啡机到货损坏，申请退款</span><ChevronRight :size="17" /></button
        ><button
          :disabled="busy"
          @click="emit('send', '帮我查一下上次售后申请的处理进度')"
        >
          <span>查询之前的申请进度</span><ChevronRight :size="17" />
        </button>
      </div>
    </div>
    <div
      v-for="m in conversation?.messages || []"
      :key="m.id"
      class="message"
      :class="m.role"
    >
      <div class="message-avatar">
        <Headphones v-if="m.role === 'assistant'" :size="19" /><span v-else>{{
          actor.name.charAt(0)
        }}</span>
      </div>
      <div class="message-main">
        <div class="message-meta">
          {{ m.role === "assistant" ? "星河售后助手" : actor.name.split(" · ")[0]
          }}<small>{{ time(m.at) }}</small>
        </div>
        <div
          v-if="m.role === 'assistant'"
          class="message-content markdown-body"
          v-html="renderMarkdown(m.content)"
        ></div>
        <div v-else class="message-content">{{ m.content }}</div>
        <button
          class="speak-button"
          :title="copied === m.id ? '已复制' : '复制消息'"
          @click="copyMessage(m.id, m.content)"
        >
          <Check v-if="copied === m.id" :size="13" /><Copy v-else :size="13" />{{
            copied === m.id ? "已复制" : "复制"
          }}
        </button>
        <div v-if="m.sourceIds?.length" class="message-sources">
          <button v-for="source in m.sourceIds" :key="source" @click="emit('sources')">
            <FileText :size="12" />{{
              policies.find((p) => p.id === source)?.title || source
            }}
          </button>
        </div>
        <button
          v-if="m.role === 'assistant' && multimodalReady"
          class="speak-button"
          :disabled="speechDisabled || (speechBusy && playingId !== m.id)"
          @click="speak(m)"
        >
          <Square v-if="playingId === m.id" :size="13" /><Volume2 v-else :size="13" />{{
            playingId === m.id ? (speechBusy ? "取消朗读" : "停止朗读") : "朗读"
          }}
        </button>
      </div>
    </div>
    <div v-if="playingId" class="speech-player" role="region" aria-label="回答朗读">
      <p role="status">{{ speechStatus }}</p>
      <audio
        v-if="audioUrl"
        ref="speechPlayer"
        :src="audioUrl"
        controls
        preload="auto"
        @playing="speechStatus = '正在朗读'"
        @pause="speechStatus = '已暂停'"
        @ended="speechStatus = '朗读结束，可再次播放'"
        @error="playbackError"
      ></audio>
      <button class="speak-button" @click="stopPlayback">
        <Square :size="13" />停止朗读
      </button>
    </div>
    <div v-if="sendingText" class="message user">
      <div class="message-avatar">{{ actor.name.charAt(0) }}</div>
      <div class="message-main">
        <div class="message-meta">
          {{ actor.name.split(" · ")[0] }}
        </div>
        <div class="message-content">{{ sendingText }}</div>
      </div>
    </div>
    <div
      v-if="sendingText && streamingAnswer"
      class="message assistant streaming-answer"
      aria-live="polite"
    >
      <div class="message-avatar"><Headphones :size="19" /></div>
      <div class="message-main">
        <div class="message-meta">星河售后助手<small>正在生成</small></div>
        <div
          class="message-content markdown-body"
          v-html="renderMarkdown(streamingAnswer)"
        ></div>
      </div>
    </div>
    <div v-if="sendingText" class="working" role="status">
      <LoaderCircle class="spin" :size="16" />{{ streamStatus }}
    </div>
    <div
      v-if="judgeResult"
      class="notice"
      :class="judgeResult.passed ? 'success' : 'warning'"
    >
      <div>
        <strong>{{ judgeResult.passed ? "回答评阅通过" : "回答需要核对" }}</strong>
        <p>{{ judgeResult.reason }}</p>
        <small>{{ judgeResult.quotes.join("；") }}</small>
      </div>
    </div>
  </div>
</template>

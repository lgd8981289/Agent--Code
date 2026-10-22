import { nextTick, onScopeDispose, ref } from "vue";
import type { Conversation, ConversationSummary } from "../../../shared/types";
import { api, streamMessage } from "../api";

/** 列表与当前详情独立保存；换账户/会话后，迟到请求不能覆盖新选择。 */
export function useConversations(scroll: () => void) {
  const conversations = ref<ConversationSummary[]>([]),
    conversation = ref<Conversation>();
  const sendingText = ref(""),
    streamingAnswer = ref(""),
    streamStatus = ref("");
  let listVersion = 0,
    detailVersion = 0,
    streamVersion = 0;
  let abort: AbortController | undefined;
  async function loadConversations() {
    const version = ++listVersion;
    const result = await api<ConversationSummary[]>("/conversations");
    if (version === listVersion) conversations.value = result;
  }
  async function loadConversation(id: string) {
    const version = ++detailVersion;
    // 换会话时不能在标题下短暂显示上一条会话的消息。
    if (conversation.value?.id !== id) conversation.value = undefined;
    if (!id) return;
    const result = await api<Conversation>(`/conversations/${id}`);
    if (version === detailVersion) conversation.value = result;
  }
  function cancel() {
    streamVersion++;
    abort?.abort();
    abort = undefined;
    sendingText.value = "";
    streamingAnswer.value = "";
  }
  function resetConversations() {
    listVersion++;
    detailVersion++;
    cancel();
    conversations.value = [];
    conversation.value = undefined;
  }
  async function sendMessage(id: string, text: string) {
    cancel();
    const version = streamVersion;
    const current = new AbortController();
    abort = current;
    sendingText.value = text;
    streamStatus.value = "正在核对订单与资料…";
    try {
      const result = await streamMessage(
        id,
        text,
        (event) => {
          if (version !== streamVersion) return;
          if (event.type === "answer.reset") streamingAnswer.value = "";
          if (event.type === "answer.delta") streamingAnswer.value += event.text;
          if (event.type === "status") streamStatus.value = event.message;
          void nextTick(scroll);
        },
        current.signal,
      );
      if (version === streamVersion) conversation.value = result;
      return result;
    } finally {
      if (version === streamVersion) {
        sendingText.value = "";
        streamingAnswer.value = "";
        abort = undefined;
      }
    }
  }
  onScopeDispose(resetConversations);
  return {
    conversations,
    conversation,
    loadConversations,
    loadConversation,
    resetConversations,
    sendMessage,
    sendingText,
    streamingAnswer,
    streamStatus,
  };
}

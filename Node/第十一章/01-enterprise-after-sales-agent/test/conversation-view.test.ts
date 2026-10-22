import { test } from "node:test";
import assert from "node:assert/strict";
import { effectScope } from "vue";
import { useConversations } from "../web/src/composables/useConversations.js";
import type { Conversation } from "../shared/types.js";

const conversation = (id: string): Conversation => ({
  id,
  tenantId: "xinghe",
  userId: "lin",
  title: id,
  mode: "replay",
  messages: [],
  proposal: null,
  caseId: null,
  materialIds: [],
  createdAt: "",
  updatedAt: "",
});
test("会话详情乱序返回时，保留最后选择的会话", async (t) => {
  const replies: Array<(response: Response) => void> = [];
  t.mock.method(
    globalThis,
    "fetch",
    () => new Promise<Response>((resolve) => replies.push(resolve)),
  );
  const scope = effectScope();
  const state = scope.run(() => useConversations(() => {}))!;
  try {
    const first = state.loadConversation("first"),
      second = state.loadConversation("second");
    replies[1](Response.json(conversation("second")));
    await second;
    replies[0](Response.json(conversation("first")));
    await first;
    assert.equal(state.conversation.value?.id, "second");
  } finally {
    scope.stop();
  }
});
test("切换账户清空会话后，迟到的列表与详情不能恢复旧用户数据", async (t) => {
  const replies: Array<(response: Response) => void> = [];
  t.mock.method(
    globalThis,
    "fetch",
    () => new Promise<Response>((resolve) => replies.push(resolve)),
  );
  const scope = effectScope();
  const state = scope.run(() => useConversations(() => {}))!;
  try {
    const list = state.loadConversations(),
      detail = state.loadConversation("old");
    state.resetConversations();
    replies[0](Response.json([{ id: "old", title: "旧账户" }]));
    replies[1](Response.json(conversation("old")));
    await Promise.all([list, detail]);
    assert.deepEqual(state.conversations.value, []);
    assert.equal(state.conversation.value, undefined);
  } finally {
    scope.stop();
  }
});

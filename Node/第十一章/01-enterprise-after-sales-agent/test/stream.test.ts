import { test } from "node:test";
import assert from "node:assert/strict";
import { AnswerStream, validateCitations } from "../server/answer-stream.js";
import { policies } from "../server/fixtures.js";
import { streamMessage } from "../web/src/api.js";
import type { ConsultationEvent, Conversation } from "../shared/types.js";

test("模型段落引用跨 token：完整验证后才发布，虚构引用不会发到页面", () => {
  const evidence = new Map(
    policies.filter((p) => p.active && p.tenantId === "xinghe").map((p) => [p.id, p]),
  );
  const events: ConsultationEvent[] = [];
  const stream = new AnswerStream(evidence, (event) => events.push(event));
  stream.push("核对材料 [POL-DAM");
  assert.equal(events.length, 0);
  stream.push("AGE-V3]。\n\n");
  assert.deepEqual(events, [
    { type: "answer.delta", text: "核对材料 [POL-DAMAGE-V3]。\n\n" },
  ]);
  stream.push("无来源 [POL-FA");
  assert.throws(() => stream.push("KE]。\n\n"), /未经核验/);
  assert.equal(events.length, 1);
  assert.throws(() => validateCitations("POL-FAKE", evidence), /未经核验/);
  stream.reset();
  stream.push("当前仍需审批。");
  stream.finish();
  assert.deepEqual(events.at(-1), { type: "answer.delta", text: "当前仍需审批。" });
});

test("浏览器 SSE 解析支持中文跨网络包，完整事件到达即显示并以 done 收尾", async (t) => {
  const conversation = { id: "test", messages: [] } as unknown as Conversation;
  const payload =
    ": heartbeat\n\n" +
    [
      { type: "answer.delta", text: "已核对咖啡机。" },
      { type: "answer.delta", text: "请补充照片。" },
      { type: "done", conversation },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (offset >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(offset, ++offset));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const events: ConsultationEvent[] = [];
  const result = await streamMessage("test", "退款", (event) => events.push(event));
  assert.deepEqual(result, conversation);
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { type: "answer.delta", text: "已核对咖啡机。" });
});

test("流中断或业务错误不能被当成成功完成", async (t) => {
  for (const payload of [
    'data: {"type":"answer.delta","text":"片段"}\n\n',
    'data: {"type":"error","message":"本会话正在处理中"}\n\n',
  ]) {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(payload, { headers: { "Content-Type": "text/event-stream" } }),
    );
    await assert.rejects(
      streamMessage("test", "退款", () => {}),
      /中断|正在处理中/,
    );
    t.mock.restoreAll();
  }
});

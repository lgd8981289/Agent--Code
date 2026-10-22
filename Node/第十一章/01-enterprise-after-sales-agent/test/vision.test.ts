import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BadGatewayException } from "@nestjs/common";
import OpenAI from "openai";
import { Materials } from "../server/materials.service.js";
import type { Storage } from "../server/storage.js";
import { accounts } from "../server/fixtures.js";
import type { Conversation } from "../shared/types.js";

test("视觉模型不可用时说明配置问题，不切换模型、不保存材料、不重试其他错误", async (t) => {
  const envKeys = ["DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "VISION_MODEL"] as const;
  const before = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of envKeys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
  const requests: string[] = [];
  let status = 404,
    code = "model_not_found";
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text).model);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code, message: "provider diagnostic" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  process.env.DASHSCOPE_API_KEY = "local-contract-only";
  process.env.DASHSCOPE_BASE_URL = `http://127.0.0.1:${address.port}/compatible-mode/v1`;
  const put = t.mock.fn();
  const materials = new Materials({ put } as unknown as Storage);
  const actor = accounts[0];
  const conversation: Conversation = {
    id: "vision-test",
    tenantId: actor.tenantId,
    userId: actor.id,
    title: "视觉测试",
    mode: "ai",
    messages: [],
    proposal: null,
    caseId: null,
    materialIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // 只供接口错误测试识别文件类型，不向真实供应商发送这个 PNG 文件头。
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const add = () => materials.add(actor, conversation, png, "test.png", "image/png");
  for (const model of ["qwen3-vl-flash", "custom-vision"]) {
    process.env.VISION_MODEL = model;
    await assert.rejects(add, (error: unknown) => {
      assert.ok(error instanceof BadGatewayException);
      assert.equal(error.getStatus(), 502);
      assert.ok(error.message.includes(model));
      assert.match(error.message, /npm run doctor -- --models/);
      assert.doesNotMatch(error.message, /provider diagnostic/);
      return true;
    });
  }
  // 路径不存在和限流不应被错误解释为模型名称问题。
  for (const failure of [
    { status: 404, code: "NotFound" },
    { status: 429, code: "rate_limit_exceeded" },
  ]) {
    ({ status, code } = failure);
    await assert.rejects(add, (error: unknown) => {
      assert.ok(error instanceof OpenAI.APIError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
  }
  assert.deepEqual(requests, [
    "qwen3-vl-flash",
    "custom-vision",
    "custom-vision",
    "custom-vision",
  ]);
  assert.equal(put.mock.callCount(), 0);
});

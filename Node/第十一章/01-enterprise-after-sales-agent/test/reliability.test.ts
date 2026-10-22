import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";
import { Traces } from "../server/trace.js";
import { Storage } from "../server/storage.js";
import { Evaluations } from "../server/evaluation.service.js";
import { cleanupResources } from "../server/lifecycle.js";
import { parseToolOutput } from "../shared/business-tools.js";
import { accounts, orders } from "../server/fixtures.js";

test("诊断 Trace 失败不覆盖业务成功结果或原始异常", async (t) => {
  const warnings = t.mock.method(Logger.prototype, "warn", () => {});
  const db = {
    put: async () => {
      throw new Error("trace unavailable");
    },
  } as unknown as Storage;
  const trace = new Traces(db),
    scope = { actor: accounts[0] };
  assert.equal(
    await trace.run(scope, "mcp", "test", {}, async () => "receipt"),
    "receipt",
  );
  const original = new Error("business failure");
  await assert.rejects(
    () =>
      trace.run(scope, "mcp", "test", {}, async () => {
        throw original;
      }),
    (error) => error === original,
  );
  assert.equal(warnings.mock.callCount(), 2);
});

test("清理按依赖顺序继续执行并保留所有失败", async () => {
  const calls: number[] = [],
    failure = new Error("close failed");
  const errors = await cleanupResources([
    () => {
      calls.push(1);
      throw failure;
    },
    async () => {
      calls.push(2);
    },
    () => {
      calls.push(3);
    },
  ]);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(errors, [failure]);
});

test("评测清理失败不覆盖原异常，下一轮仍能启动", async (t) => {
  t.mock.method(Logger, "warn", () => {});
  t.mock.method(Storage.prototype, "setup", async () => {
    throw new Error("setup failed");
  });
  let creates = 0,
    drops = 0;
  // 只模拟数据库管理命令，不创建真实数据库；隔离 Storage 尚未建立连接。
  const db = {
    pool: {
      query: async (sql: string) => {
        if (sql.startsWith("CREATE")) creates++;
        if (sql.startsWith("DROP")) {
          drops++;
          throw new Error("cleanup failed");
        }
        return { rows: [] };
      },
    },
  } as unknown as Storage;
  const evaluator = new Evaluations(db);
  for (let i = 0; i < 2; i++)
    await assert.rejects(() => evaluator.run(accounts[2], "current"), /setup failed/);
  assert.equal(creates, 2);
  assert.equal(drops, 2);
});

test("工具返回契约拒绝缺失字段、非整数金额和错误回执", () => {
  assert.deepEqual(parseToolOutput("get_order", orders[0]), orders[0]);
  assert.equal(parseToolOutput("get_refund", null), null);
  assert.throws(() => parseToolOutput("get_order", { id: "A1024" }), /不符合约定/);
  assert.throws(
    () => parseToolOutput("get_order", { ...orders[0], paidCents: 3500.5 }),
    /paidCents/,
  );
  assert.throws(() => parseToolOutput("submit_refund", null), /不符合约定/);
});

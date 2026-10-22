import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedSystem } from "../helpers/system.js";
import { Evaluations } from "../../server/evaluation.service.js";
import { accounts } from "../../server/fixtures.js";
test("真实 MCP、Postgres、工作流与回归版本对比", { timeout: 180000 }, async () => {
  const { db, close } = await isolatedSystem();
  try {
    const evaluator = new Evaluations(db);
    const current = await evaluator.run(accounts[2], "current");
    assert.deepEqual(
      current.items.filter((i) => i.status !== "passed"),
      [],
      JSON.stringify(current.items, null, 2),
    );
    assert.equal(current.gate, "passed");
    const baseline = await evaluator.run(accounts[2], "baseline");
    assert.equal(baseline.items.find((i) => i.id === "order-answer")?.status, "failed");
    assert.equal(baseline.gate, "blocked");
    assert.equal(current.total, 10);
  } finally {
    await close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isolatedSystem } from "../helpers/system.js";
import { accounts } from "../../server/fixtures.js";

test("MCP 子进程断开后，下一次读取重新连接并保留权限检查", async () => {
  const system = await isolatedSystem();
  try {
    const { mcp } = system;
    assert.equal(
      (await mcp.call(accounts[0], "get_order", { orderId: "A1024" })).id,
      "A1024",
    );
    const cache = (mcp as unknown as { clients: Map<string, Promise<Client>> }).clients;
    const previous = await cache.get(accounts[0].id)!;
    await previous.close();
    assert.equal(
      (await mcp.call(accounts[0], "get_order", { orderId: "A1024" })).id,
      "A1024",
    );
    assert.notEqual(await cache.get(accounts[0].id), previous);
    await assert.rejects(
      () => mcp.call(accounts[0], "get_order", { orderId: "A1025" }),
      /无权/,
    );
    const c = await system.app.createConversation(accounts[0], "replay");
    await system.app.send(accounts[0], c.id, "查询 A1024 订单");
    const summaries = await system.app.conversationSummaries(accounts[0]);
    assert.equal(summaries[0].id, c.id);
    assert.ok(!("messages" in summaries[0]));
    assert.ok(!("evidence" in summaries[0]));
    assert.deepEqual(await system.app.conversationSummaries(accounts[1]), []);
    const bootstrap = await system.app.bootstrap(accounts[0]);
    assert.ok(!("conversations" in bootstrap));
    assert.ok(!("cases" in bootstrap));
    assert.ok(!("evaluations" in bootstrap));
  } finally {
    await system.close();
  }
});

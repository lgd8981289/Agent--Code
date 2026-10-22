import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isolatedSystem } from "../helpers/system.js";
import { accounts } from "../../server/fixtures.js";
import { root } from "../../server/config.js";
import { Evaluations } from "../../server/evaluation.service.js";

test("材料、订单、申请版本与调查保持一致", { timeout: 120000 }, async () => {
  const { app, close } = await isolatedSystem(),
    actor = accounts[0];
  try {
    const c = await app.createConversation(actor, "replay");
    await app.send(actor, c.id, "A1024 咖啡机外壳裂了，申请退款");
    const photo = await app.addMaterial(
      actor,
      c.id,
      await readFile(join(root, "samples/damaged-coffee-machine.png")),
      "photo.png",
      "image/png",
    );
    await app.confirmMaterial(actor, photo.id, "外壳有裂痕");
    const switched = await app.send(actor, c.id, "再看看 A1026");
    assert.equal(switched.proposal?.reason, "");
    assert.equal((await app.materialList(actor, c.id)).length, 0);
    assert.ok(switched.proposal?.missing.some((s) => s.includes("照片")));
    await assert.rejects(
      async () =>
        app.submit(actor, c.id, {
          orderId: "A1026",
          draftVersion: (await app.conversation(actor, c.id)).draftVersion ?? 0,
          amountCents: 69900,
          reason: "热水壶漏水",
          fault: "none",
        }),
      /照片/,
    );
    await app.send(actor, c.id, "回到 A1024，外壳损坏");
    await app.removeMaterial(actor, photo.id);
    const removed = await app.send(actor, c.id, "还需要什么材料");
    assert.match(removed.messages.at(-1)!.content, /请上传损坏照片/);
    assert.ok(removed.proposal?.missing.some((s) => s.includes("照片")));
    const replacement = await app.addMaterial(
      actor,
      c.id,
      await readFile(join(root, "samples/damaged-coffee-machine.png")),
      "replacement.png",
      "image/png",
    );
    await app.confirmMaterial(actor, replacement.id, "外壳有裂痕");
    const stale = await app.conversation(actor, c.id);
    await app.confirmMaterial(actor, replacement.id, "重新确认：外壳有裂痕");
    await assert.rejects(
      () =>
        app.submit(actor, c.id, {
          orderId: "A1024",
          draftVersion: stale.draftVersion ?? 0,
          amountCents: 350000,
          reason: "外壳损坏",
          fault: "none",
        }),
      /草稿/,
    );
    await assert.rejects(
      async () =>
        app.submit(actor, c.id, {
          orderId: "A1026",
          draftVersion: (await app.conversation(actor, c.id)).draftVersion ?? 0,
          amountCents: 350000,
          reason: "外壳损坏",
          fault: "none",
        }),
      /草稿/,
    );
    const item = await app.submit(actor, c.id, {
      orderId: "A1024",
      draftVersion: (await app.conversation(actor, c.id)).draftVersion ?? 0,
      amountCents: 350000,
      reason: "外壳损坏",
      fault: "none",
    });
    const investigated = await app.investigate(actor, item.id, "replay");
    assert.equal(investigated.investigation?.caseVersion, 1);
    assert.equal(investigated.investigation?.inputHash?.length, 64);
    const revised = await app.revise(actor, item.id, {
      version: 1,
      amountCents: 300000,
      reason: "调整申请金额",
    });
    assert.equal(revised.investigation?.status, "stale");
    await assert.rejects(
      () =>
        app.review(accounts[2], item.id, {
          version: 1,
          decision: "approve",
          note: "",
        }),
      /版本/,
    );
    // 提交后的其他订单查询不能偷换申请的材料归属。
    await app.send(actor, c.id, "查 A1026");
    assert.equal((await app.conversation(actor, c.id)).proposal?.order.id, "A1024");
    assert.equal((await app.materialList(actor, c.id))[0].orderId, "A1024");
  } finally {
    await close();
  }
});

test(
  "AI 连续追问、非法引用隔离及批量评测通过真实入口执行",
  { timeout: 180000 },
  async () => {
    const requests: any[] = [];
    const call = (name: string, args: object) => ({
      id: randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    let judgeBroken = false;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        const body = JSON.parse(raw);
        requests.push(body);
        const system =
          body.messages.find((m: any) => m.role === "system")?.content || "";
        const last =
          body.messages.filter((m: any) => m.role === "user").at(-1)?.content || "";
        let content: string | null = "",
          calls: any[] | undefined;
        if (system.includes("独立回答评分器")) {
          const input = JSON.parse(last);
          content = JSON.stringify({
            passed: true,
            reason: "与真实资料一致，未越权承诺退款",
            quotes: [judgeBroken ? "不存在的逐字引用" : input.answer.slice(0, 12)],
          });
        } else if (last.includes("制造非法引用"))
          content = "非法回答不应被沿用 [POL-FAKE-V9]";
        else if (last.includes("用一句话") || last.includes("继续核对"))
          content = "企业审核当前申请版本后才能执行。 [POL-APPROVAL-V4]";
        else {
          const orderId = last.includes("A1026")
            ? "A1026"
            : last.includes("A1025")
              ? "A1025"
              : "A1024";
          if (!body.messages.some((m: any) => m.role === "tool")) {
            calls = [call("get_order", { orderId })];
            if (orderId !== "A1025") {
              calls.push(
                ...(
                  [
                    ["eligibility", "到货损坏签收退款"],
                    ["materials", "损坏照片申请材料"],
                    ["approval", "退款人工审批金额"],
                  ] as const
                ).map(([category, query]) =>
                  call("search_policy", { category, query }),
                ),
              );
              if (last.includes("准备"))
                calls.push(
                  call("prepare_refund_draft", {
                    orderId,
                    reason: orderId === "A1026" ? "热水壶开机漏水" : "咖啡机外壳损坏",
                  }),
                );
            }
            content = null;
          } else
            content =
              orderId === "A1025"
                ? "无权查看其他客户订单，请由本人登录查询。"
                : orderId === "A1026"
                  ? "热水壶漏水草稿已准备，实付 699 元，等待客户确认与企业审核。 [POL-APPROVAL-V4]"
                  : "订单 A1024 实付 3500 元，需确认材料与企业审核，尚未执行退款。 [POL-APPROVAL-V4]";
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-" + randomUUID(),
            object: "chat.completion",
            created: 1,
            model: "local-contract",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content,
                  ...(calls ? { tool_calls: calls } : {}),
                },
                finish_reason: calls ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 10,
              total_tokens: 30,
            },
          }),
        );
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: (e as Error).message } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const keys = [
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
      "KNOWLEDGE_BACKEND",
    ] as const;
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.DEEPSEEK_API_KEY = "local-contract-only";
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    process.env.KNOWLEDGE_BACKEND = "local";
    const { app, db, close } = await isolatedSystem(),
      actor = accounts[0];
    try {
      const c = await app.createConversation(actor, "ai");
      await app.send(actor, c.id, "A1024 咖啡机损坏，查询政策");
      const second = await app.send(actor, c.id, "用一句话说明审核要求");
      assert.equal(second.messages.at(-1)?.status, "accepted");
      assert.ok(
        second.messages.at(-1)?.sources?.some((p) => p.id === "POL-APPROVAL-V4"),
      );
      const failed = await app.send(actor, c.id, "制造非法引用");
      assert.equal(failed.messages.at(-1)?.status, "error");
      const recovered = await app.send(actor, c.id, "继续核对");
      assert.equal(recovered.messages.at(-1)?.status, "accepted");
      assert.ok(!JSON.stringify(requests.at(-1)).includes("POL-FAKE-V9"));
      assert.ok(!JSON.stringify(requests.at(-1)).includes("制造非法引用"));
      const evaluation = new Evaluations(db);
      const report = await evaluation.run(accounts[2], "current", {
        mode: "ai",
        model: "contract-test",
        prompt: "课程测试提示词",
      });
      assert.equal(report.mode, "ai");
      assert.equal(report.total, 15);
      assert.equal(
        report.gate,
        "passed",
        JSON.stringify(report.items.filter((i) => i.status !== "passed")),
      );
      assert.equal(report.snapshot?.model, "contract-test");
      assert.equal(report.snapshot?.codeHash.length, 64);
      assert.equal(
        report.items.filter(
          (i) =>
            i.mode === "ai" &&
            i.rule?.status === "passed" &&
            i.judge?.status === "passed" &&
            i.traces?.length,
        ).length,
        5,
      );
      const { runAiSuite } = await import("../../server/evaluation/ai-suite.js");
      const scoringErrors = await runAiSuite(app, db, actor, async () => {
        throw new Error("评分服务不可用");
      });
      assert.ok(
        scoringErrors.every(
          (item) =>
            item.rule?.status === "passed" &&
            item.judge?.status === "error" &&
            item.status === "error",
        ),
      );
      judgeBroken = true;
      const judgeTraces = await app.traces(actor, c.id, "conversation");
      await assert.rejects(() => evaluation.judge(recovered, judgeTraces), /引用/);
    } finally {
      await close();
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

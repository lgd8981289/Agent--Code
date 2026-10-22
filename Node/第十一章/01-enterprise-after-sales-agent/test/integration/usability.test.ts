import "reflect-metadata";
import { createApplication } from "../../server/application.factory.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Storage } from "../../server/storage.js";
import { McpBridge } from "../../server/mcp.js";
import { Knowledge } from "../../server/knowledge.service.js";
import { accounts, orders } from "../../server/fixtures.js";
import { databaseUrl, root } from "../../server/config.js";

test(
  "企业使用细节：材料、撤回、审计、检索、并发和执行故障",
  { timeout: 180000 },
  async (t) => {
    const admin = new Storage();
    const name = "af_usability_" + randomUUID().replaceAll("-", "");
    const url = new URL(databaseUrl);
    url.pathname = "/" + name;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const db = new Storage(url.href),
      mcp = new McpBridge({ POSTGRES_URI: url.href });
    const { app, workflow } = createApplication(db, mcp, new Knowledge());
    const [customer, other, reviewer] = accounts;
    const files = new Set<string>();
    const photo = await readFile(join(root, "samples/damaged-coffee-machine.png"));
    const addPhoto = async (id: string) => {
      const m = await app.addMaterial(customer, id, photo, "照片.png", "image/png");
      files.add(m.id);
      return m;
    };
    const reset = async () => {
      await db.pool.query(
        "DELETE FROM af_refunds; DELETE FROM af_records WHERE kind IN ('case','conversation','material')",
      );
      for (const order of orders) await db.put("order", { ...order, refundedCents: 0 });
    };
    const prepare = async () => {
      await reset();
      const c = await app.createConversation(customer, "replay");
      await app.send(customer, c.id, "A1024 到货外壳损坏，申请退款");
      const m = await addPhoto(c.id);
      await app.confirmMaterial(customer, m.id, m.observation);
      const item = await app.submit(customer, c.id, {
        orderId: "A1024",
        draftVersion: (await app.conversation(customer, c.id)).draftVersion ?? 0,
        amountCents: 350000,
        reason: "到货外壳损坏",
        fault: "none",
      });
      return { c, m, item };
    };
    try {
      await db.setup();
      await workflow.onModuleInit();
      await t.test("重复文件不再上传；材料上限与用户归属生效", async () => {
        const c = await app.createConversation(customer, "replay");
        const a = await addPhoto(c.id),
          b = await addPhoto(c.id);
        assert.equal(a.id, b.id);
        await assert.rejects(() => app.removeMaterial(other, a.id), /无权/);
        for (let i = 0; i < 9; i++) {
          const doc = await app.addMaterial(
            customer,
            c.id,
            Buffer.from("售后材料编号" + i),
            i + ".txt",
            "text/plain",
          );
          files.add(doc.id);
        }
        await assert.rejects(
          () =>
            app.addMaterial(
              customer,
              c.id,
              Buffer.from("超出数量"),
              "多余.txt",
              "text/plain",
            ),
          /10/,
        );
        await app.removeMaterial(customer, a.id);
        assert.equal((await app.materialList(customer, c.id)).length, 9);
      });
      await t.test("材料变更保留旧版快照；删除唯一照片后必须重新补充", async () => {
        const { c, m, item } = await prepare();
        await assert.rejects(() => app.removeMaterial(customer, m.id, 99), /版本/);
        await app.removeMaterial(customer, m.id, 1);
        let current = await app.getCase(customer, item.id);
        assert.equal(current.status, "needs_materials");
        assert.equal(current.version, 2);
        assert.equal(current.history![0].materials[0].observation, m.observation);
        await assert.rejects(
          () =>
            app.revise(customer, item.id, {
              version: 2,
              amountCents: 350000,
              reason: "重新送审申请",
            }),
          /照片/,
        );
        const replacement = await addPhoto(c.id);
        await app.confirmMaterial(
          customer,
          replacement.id,
          "重新核对，右侧存在裂痕",
          2,
        );
        await app.revise(customer, item.id, {
          version: 3,
          amountCents: 350000,
          reason: "已补充新照片",
        });
        current = await app.review(reviewer, item.id, {
          version: 4,
          decision: "approve",
          note: "已核对补充材料",
        });
        assert.equal(current.status, "completed");
        assert.equal(
          current.history!.at(-1)!.materials[0].observation,
          "重新核对，右侧存在裂痕",
        );
        await assert.rejects(
          () => app.removeMaterial(customer, replacement.id, 4),
          /终态/,
        );
      });
      await t.test("撤回关闭持久化等待；重复撤回不产生额外记录", async () => {
        const { item } = await prepare();
        await assert.rejects(() => app.cancel(other, item.id, 1, "撤回申请"), /无权/);
        const result = await app.cancel(customer, item.id, 1, "误选订单，撤回重填");
        assert.equal(result.status, "cancelled");
        const repeated = await app.cancel(customer, item.id, 1, "重复点击撤回");
        assert.equal(repeated.history!.length, result.history!.length);
        await assert.rejects(
          () =>
            app.review(reviewer, item.id, {
              version: 1,
              decision: "approve",
              note: "",
            }),
          /待审核/,
        );
        await assert.rejects(
          () => mcp.call(customer, "submit_refund", { caseId: item.id }),
          /审批/,
        );
        const snapshot = await db.saver.getTuple({
          configurable: { thread_id: "refund-flow:" + item.id },
        });
        assert.ok(snapshot);
        assert.deepEqual(
          (
            await workflow["graph"].getState({
              configurable: { thread_id: "refund-flow:" + item.id },
            })
          ).next,
          [],
        );
        assert.equal(
          (await db.pool.query("SELECT count(*) FROM af_refunds")).rows[0].count,
          "0",
        );
        const c = await app.createConversation(customer, "replay");
        await app.send(customer, c.id, "A1024 到货损坏");
        const m = await addPhoto(c.id);
        await app.confirmMaterial(customer, m.id, m.observation);
        const next = await app.submit(customer, c.id, {
          orderId: "A1024",
          draftVersion: (await app.conversation(customer, c.id)).draftVersion ?? 0,
          amountCents: 350000,
          reason: "重新申请售后",
          fault: "none",
        });
        assert.notEqual(next.id, item.id);
        const returned = await app.review(reviewer, next.id, {
          version: 1,
          decision: "revise",
          note: "请补充包装照片",
        });
        await app.cancel(customer, returned.id, 1, "不再申请退款");
        await workflow.onModuleInit();
        assert.equal((await app.getCase(customer, returned.id)).status, "cancelled");
      });
      await t.test("拒绝和退回必须给出原因；审批与撤回竞争只有一方成功", async () => {
        const { item } = await prepare();
        for (const decision of ["reject", "revise"] as const)
          await assert.rejects(
            () =>
              app.review(reviewer, item.id, {
                version: 1,
                decision,
                note: "  ",
              }),
            /原因/,
          );
        const results = await Promise.allSettled([
          app.cancel(customer, item.id, 1, "客户主动撤回"),
          app.review(reviewer, item.id, {
            version: 1,
            decision: "approve",
            note: "核对完成",
          }),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const latest = await app.getCase(customer, item.id);
        const refunds = Number(
          (await db.pool.query("SELECT count(*) FROM af_refunds")).rows[0].count,
        );
        assert.equal(refunds, latest.status === "completed" ? 1 : 0);
      });
      await t.test("退款前查询失败也进入可核对状态，恢复后不会卡在已批准", async () => {
        const { item } = await prepare();
        const original = mcp.call.bind(mcp);
        let failOnce = true;
        mcp.call = (async (...args: Parameters<typeof mcp.call>) => {
          if (args[1] === "get_order" && failOnce) {
            failOnce = false;
            throw new Error("测试：订单服务暂不可用");
          }
          return original(...args);
        }) as typeof mcp.call;
        const failed = await app.review(reviewer, item.id, {
          version: 1,
          decision: "approve",
          note: "",
        });
        assert.equal(failed.status, "unknown");
        assert.match(failed.lastError!, /暂不可用/);
        const recovered = await app.retry(customer, item.id);
        assert.equal(recovered.status, "completed");
        assert.equal(recovered.attempts, 2);
        mcp.call = original;
      });
      await t.test("超过连接池大小的重复请求可以串行完成", async () => {
        let count = 0;
        await Promise.all(
          Array.from({ length: 20 }, () =>
            db.locked("contention-test", async () => {
              await db.pool.query("SELECT 1");
              count++;
            }),
          ),
        );
        assert.equal(count, 20);
      });
      await t.test(
        "重新送审保存成功但 Graph 尚未恢复时，后续批准仍能接上流程",
        async () => {
          const { item } = await prepare();
          await app.review(reviewer, item.id, {
            version: 1,
            decision: "revise",
            note: "补充商品损坏说明",
          });
          const original = workflow.supplemented.bind(workflow);
          workflow.supplemented = async () => {
            throw new Error("模拟保存后进程退出");
          };
          await assert.rejects(
            () =>
              app.revise(customer, item.id, {
                version: 1,
                amountCents: 350000,
                reason: "补充右侧外壳裂痕说明",
              }),
            /进程退出/,
          );
          workflow.supplemented = original;
          const completed = await app.review(reviewer, item.id, {
            version: 2,
            decision: "approve",
            note: "新说明已核对",
          });
          assert.equal(completed.status, "completed");
          assert.equal(
            (await db.pool.query("SELECT count(*) FROM af_refunds")).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "服务端分页查询覆盖 200 条以后的数据，并限制租户和客户",
        async () => {
          const { item } = await prepare();
          for (let i = 0; i < 205; i++)
            await db.put("case", {
              ...item,
              id: randomUUID(),
              number: "AS-SEARCH-" + i,
              status: "cancelled",
              reason: "分页边界",
              createdAt: new Date(2020, 0, 1, 0, 0, i).toISOString(),
            });
          const input = {
            query: "分页边界",
            status: "cancelled" as const,
            page: 11,
            pageSize: 20,
            sort: "oldest" as const,
          };
          const page = await app.casePage(customer, input);
          assert.equal(page.total, 205);
          assert.equal(page.items.length, 5);
          assert.equal((await app.casePage(other, input)).total, 0);
          assert.equal((await app.casePage(accounts[3], input)).total, 0);
          assert.equal(
            (
              await app.casePage(reviewer, {
                ...input,
                query: "AS-SEARCH-204",
                page: 1,
              })
            ).total,
            1,
          );
        },
      );
      await t.test("自定义会话标题不会被下一轮回答覆盖", async () => {
        const c = await app.createConversation(customer, "replay");
        await app.renameConversation(customer, c.id, "咖啡机售后跟进");
        await app.send(customer, c.id, "查询 A1024 的金额");
        assert.equal((await app.conversation(customer, c.id)).title, "咖啡机售后跟进");
      });
      await t.test(
        "会话删除只影响本人列表；关联申请和材料保留，并可重新打开",
        async () => {
          const { c, m, item } = await prepare();
          await assert.rejects(
            () => app.setConversationDeleted(other, c.id, true),
            /无权/,
          );
          await assert.rejects(
            () => app.setConversationDeleted(accounts[3], c.id, true),
            /无权/,
          );
          const before = await app.getCase(customer, item.id);
          const removed = await app.setConversationDeleted(customer, c.id, true);
          const repeated = await app.setConversationDeleted(customer, c.id, true);
          assert.equal(removed.deletedAt, repeated.deletedAt);
          assert.equal(
            (await app.conversationSummaries(customer)).some((v) => v.id === c.id),
            false,
          );
          assert.deepEqual(await app.getCase(customer, item.id), before);
          assert.equal((await app.materialList(customer, c.id))[0].id, m.id);
          await app.revise(customer, item.id, {
            version: 1,
            amountCents: 350000,
            reason: "补充外壳损坏说明",
          });
          assert.equal((await app.getCase(customer, item.id)).version, 2);
          assert.equal((await app.conversationSummaries(customer)).length, 0);
          await assert.rejects(
            () => app.setConversationDeleted(other, c.id, false),
            /无权/,
          );
          await app.setConversationDeleted(customer, c.id, false);
          assert.equal((await app.conversationSummaries(customer))[0].id, c.id);
          assert.equal((await app.conversation(customer, c.id)).messages.length, 2);
        },
      );
      await t.test("已删除会话不占用会话列表的显示名额", async () => {
        await reset();
        const c = await app.createConversation(customer, "replay");
        const stamp = new Date().toISOString();
        for (let i = 0; i < 201; i++) {
          await db.put("conversation", {
            ...c,
            id: randomUUID(),
            deletedAt: stamp,
          });
        }
        const visible = await app.conversationSummaries(customer);
        assert.deepEqual(
          visible.map((v) => v.id),
          [c.id],
        );
      });
    } finally {
      await mcp.onModuleDestroy();
      await db.onModuleDestroy();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.onModuleDestroy();
      await Promise.allSettled(
        [...files].map((id) => unlink(join(root, "data/materials", id))),
      );
    }
  },
);

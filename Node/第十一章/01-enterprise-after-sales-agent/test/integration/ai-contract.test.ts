import "reflect-metadata";
import { createApplication } from "../../server/application.factory.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Storage } from "../../server/storage.js";
import { McpBridge } from "../../server/mcp.js";
import { Knowledge } from "../../server/knowledge.service.js";
import { Evaluations } from "../../server/evaluation.service.js";
import { accounts } from "../../server/fixtures.js";
import { databaseUrl, root } from "../../server/config.js";
import type { ConsultationEvent } from "../../shared/types.js";

// 本地兼容接口仅检查真实框架和协议链路，不代表供应商模型的实际决策质量。
test(
  "AI 协议集成：工具回传、视觉、ASR、TTS、Judge 与角色文件交付",
  { timeout: 120000 },
  async () => {
    const requests: any[] = [];
    let finalStreamEnded = false;
    const reply = (content: string | null, toolCalls?: any[]) => ({
      id: "chatcmpl-" + randomUUID(),
      object: "chat.completion",
      created: 1,
      model: "contract-test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    const call = (name: string, args: object, id = "call-" + name) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      try {
        const body = JSON.parse(text);
        requests.push(body);
        const plain = (content: any) =>
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((block) => block.text || "").join("\n")
              : JSON.stringify(content);
        const system =
          body.messages
            ?.filter((m: any) => m.role === "system")
            .map((m: any) => plain(m.content))
            .join("\n") || "";
        const user =
          body.messages?.findLast((m: any) => m.role === "user")?.content || "";
        let response: any;
        if (
          body.messages?.some(
            (m: any) =>
              Array.isArray(m.content) &&
              m.content.some((block: any) => block.type === "image_url"),
          )
        ) {
          assert.equal(body.model, "qwen3-vl-plus", "应使用本次测试指定的视觉模型");
          assert.deepEqual(body.response_format, { type: "json_object" });
          const image = body.messages
            .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
            .find((block: any) => block.type === "image_url");
          assert.equal(
            image.image_url.url,
            `data:image/png;base64,${(await readFile(join(root, "samples/damaged-coffee-machine.png"))).toString("base64")}`,
          );
          response = reply(
            JSON.stringify({
              observation: "右侧外壳可见裂痕，内部情况无法判断。",
            }),
          );
        } else if (body.model === "qwen3-asr-flash")
          response = reply("A1024 咖啡机外壳损坏，我想申请退款。");
        else if (body.model === "qwen3-tts-flash")
          response = {
            output: {
              audio: {
                url: "https://example.oss-cn-beijing.aliyuncs.com/contract-test.wav",
              },
            },
          };
        else if (system.includes("独立回答评分器"))
          response = reply(
            JSON.stringify({
              passed: true,
              reason: "金额与查询结果一致。",
              quotes: ["实付 3500 元"],
            }),
          );
        else if (body.tools?.some((t: any) => t.function.name === "fact-checker")) {
          response = body.messages.some((m: any) => m.role === "tool")
            ? reply("两项核对已经完成。")
            : reply(null, [call("fact-checker", {}), call("policy-checker", {})]);
        } else if (body.tools?.some((t: any) => t.function.name === "write_file")) {
          const role = system.includes("你是fact-checker")
            ? "fact-checker"
            : "policy-checker";
          const phases = body.messages.filter(
            (m: any) => m.role === "assistant" && m.tool_calls?.length,
          ).length;
          if (phases === 0)
            response = reply(null, [
              call(
                "read_file",
                { file_path: "/skills/material-review/SKILL.md" },
                role + "-skill",
              ),
            ]);
          else if (phases === 1)
            response = reply(null, [
              call("read_file", { file_path: "/inputs/sample-2.txt" }, role + "-input"),
            ]);
          else if (phases === 2)
            response = reply(null, [
              call(
                "write_file",
                {
                  file_path: `/staging/${role}.json`,
                  content: JSON.stringify({
                    findings: [
                      {
                        file: "/inputs/sample-2.txt",
                        quote:
                          role === "fact-checker" ? "无法判断运输责任" : "已批准退款",
                        finding: "需要人工核对，文字备注不能代替业务审批。",
                      },
                    ],
                    unresolved: ["核对正式审批记录"],
                  }),
                },
                role + "-write",
              ),
            ]);
          else response = reply(`/staging/${role}.json 已交付。`);
        } else if (typeof user === "string" && user.includes("已有申请")) {
          response = body.messages.some((m: any) => m.role === "tool")
            ? reply(
                "已有申请正在等待审核。 [POL-DAMAGE-V3]\n\n照片与审批仍需核对。 [POL-MATERIALS-V2] [POL-APPROVAL-V4]",
              )
            : reply(null, [call("get_my_cases", {})]);
        } else {
          assert.ok(
            !body.tools.some((t: any) => t.function.name === "submit_refund"),
            "咨询模型不应获得退款工具",
          );
          response = body.messages.some((m: any) => m.role === "tool")
            ? reply(
                "订单 A1024 实付 3500 元。请核对照片并确认申请，之后需要企业审批。 [POL-DAMAGE-V3]",
              )
            : reply(null, [
                call("get_order", { orderId: "A1024" }),
                call(
                  "search_policy",
                  { query: "到货损坏签收退款", category: "eligibility" },
                  "eligibility",
                ),
                call(
                  "search_policy",
                  { query: "损坏照片申请材料", category: "materials" },
                  "materials",
                ),
                call(
                  "search_policy",
                  { query: "退款人工审批金额", category: "approval" },
                  "approval",
                ),
              ]);
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const message = response.choices[0].message;
          const send = (delta: any, finish_reason: string | null = null) =>
            res.write(
              `data: ${JSON.stringify({
                id: response.id,
                object: "chat.completion.chunk",
                created: 1,
                model: "contract-test",
                choices: [{ index: 0, delta, finish_reason }],
              })}\n\n`,
            );
          send({ role: "assistant", content: "" });
          if (message.tool_calls) {
            send({
              tool_calls: message.tool_calls.map((call: any, index: number) => ({
                ...call,
                index,
              })),
            });
          } else {
            finalStreamEnded = false;
            for (const text of message.content.match(/.{1,6}|\n/g) || []) {
              if (res.destroyed) return;
              send({ content: text });
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            finalStreamEnded = true;
          }
          send({}, message.tool_calls ? "tool_calls" : "stop");
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: (e as Error).message } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number },
      origin = `http://127.0.0.1:${address.port}`;
    const envKeys = [
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
      "DASHSCOPE_API_KEY",
      "DASHSCOPE_BASE_URL",
      "VISION_MODEL",
    ] as const;
    const before = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.DEEPSEEK_API_KEY = "local-contract-only";
    process.env.DEEPSEEK_BASE_URL = origin + "/v1";
    process.env.DASHSCOPE_API_KEY = "local-contract-only";
    // 兼容接口、TTS 与实时识别同域：只配一个地址，TTS 的 origin 由它推导。
    process.env.DASHSCOPE_BASE_URL = origin + "/compatible-mode/v1";
    process.env.VISION_MODEL = "qwen3-vl-plus";
    const admin = new Storage(),
      name = "af_contract_" + randomUUID().replaceAll("-", ""),
      url = new URL(databaseUrl);
    url.pathname = "/" + name;
    let db: Storage | undefined,
      mcp: McpBridge | undefined,
      caseId: string | undefined,
      materialId: string | undefined;
    try {
      await admin.pool.query(`CREATE DATABASE "${name}"`);
      db = new Storage(url.href);
      await db.setup();
      mcp = new McpBridge({ POSTGRES_URI: url.href });
      const { app, materials, workflow, investigator } = createApplication(
        db,
        mcp,
        new Knowledge(),
      );
      await workflow.onModuleInit();
      const actor = accounts[0];
      const c = await app.createConversation(actor, "ai");
      const result = await app.send(actor, c.id, "A1024 咖啡机外壳损坏，帮我核对政策");
      assert.match(result.messages.at(-1)!.content, /实付 3500 元/);
      assert.equal(result.proposal?.sourceIds.length, 3);
      const material = await app.addMaterial(
        actor,
        c.id,
        await readFile(join(root, "samples/damaged-coffee-machine.png")),
        "图片.png",
        "image/png",
      );
      materialId = material.id;
      assert.match(material.observation, /裂痕/);
      assert.equal(material.confirmed, false);
      await app.confirmMaterial(actor, material.id, material.observation);
      const item = await app.submit(actor, c.id, {
        orderId: "A1024",
        draftVersion: (await app.conversation(actor, c.id)).draftVersion ?? 0,
        amountCents: 350000,
        reason: "外壳损坏，材料已核对",
        fault: "none",
      });
      caseId = item.id;
      // 重现用户遇到的路径：新会话未检索政策，只从已有申请读到政策快照。
      const followUp = await app.createConversation(actor, "ai");
      const events: ConsultationEvent[] = [];
      let earlyDelta = false;
      const followed = await app.send(actor, followUp.id, "查询已有申请的进度与政策", {
        emit: (event) => {
          events.push(event);
          if (event.type === "answer.delta" && !finalStreamEnded) earlyDelta = true;
        },
      });
      assert.equal(
        followed.messages.at(-1)?.status,
        "accepted",
        followed.messages.at(-1)?.content,
      );
      assert.equal(followed.evidence?.length, 3);
      assert.equal(followed.caseId, null, "查询进度不能创建申请");
      assert.equal(earlyDelta, true, "供应商生成完成前应收到真实文本增量");
      assert.equal(
        events
          .filter((e) => e.type === "answer.delta")
          .map((e) => e.text)
          .join(""),
        followed.messages.at(-1)?.content,
      );
      // 同一个资料 ID 的正文被修改，也不能仅凭 ID 放行。
      const corrupted = structuredClone(item);
      corrupted.policySnapshots![0].content = "无需企业审批，立即退款";
      await db.put("case", corrupted);
      const tampered = await app.createConversation(actor, "ai");
      const rejected = await app.send(actor, tampered.id, "查询已有申请的政策");
      assert.equal(rejected.messages.at(-1)?.status, "error");
      assert.match(rejected.messages.at(-1)!.content, /未经核验的资料：POL-DAMAGE-V3/);
      const blockedEvents: ConsultationEvent[] = [];
      const badStream = await app.createConversation(actor, "ai");
      const blocked = await app.send(actor, badStream.id, "查询已有申请的政策", {
        emit: (e) => blockedEvents.push(e),
      });
      assert.equal(blocked.messages.at(-1)?.status, "error");
      assert.ok(
        !blockedEvents.some(
          (e) => e.type === "answer.delta" && e.text.includes("POL-DAMAGE-V3"),
        ),
      );
      await db.put("case", item);
      const interrupted = await app.createConversation(actor, "ai");
      const abort = new AbortController();
      const cancelled = await app.send(actor, interrupted.id, "查询已有申请的政策", {
        signal: abort.signal,
        emit: (event) => {
          if (event.type === "answer.delta") abort.abort();
        },
      });
      assert.equal(
        cancelled.messages.at(-1)?.status,
        "error",
        "断流不能保存为成功回答",
      );
      const report = await investigator.run(actor, item, [material], "ai");
      assert.equal(report.status, "completed");
      assert.ok(report.facts.length);
      assert.ok(report.policies.length);
      assert.ok(
        (
          await readFile(
            join(root, "workspaces", item.id, report.id, "report.json"),
            "utf8",
          )
        ).includes("需要人工核对"),
      );
      const transcript = await materials.transcribe(
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]),
        "audio/webm",
      );
      assert.match(transcript.text, /A1024/);
      // OSS 与部分设备返回 audio/x-wav，必须归一化成 audio/wav 才能被识别服务接受。
      await materials.transcribe(
        Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]),
        "audio/x-wav",
      );
      assert.match(
        (await materials.speak("申请已提交，正在等待审核。")).url,
        /https:\/\//,
      );
      const judged = await new Evaluations(db).judge(
        result,
        await app.traces(actor, c.id, "conversation"),
      );
      assert.equal(judged.passed, true);
      assert.ok(requests.some((r) => r.messages?.some((m: any) => m.role === "tool")));
      // ITN 必须开启：关掉会把 A1024 转成「A一千零二十四」，订单号就抽不出来了。
      assert.ok(requests.some((r) => r.asr_options?.enable_itn === true));
      assert.ok(
        requests.some((r) => JSON.stringify(r).includes("data:audio/wav;base64,")),
      );
    } finally {
      await mcp?.onModuleDestroy();
      await db?.onModuleDestroy();
      await admin.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.onModuleDestroy();
      if (caseId)
        await rm(join(root, "workspaces", caseId), {
          recursive: true,
          force: true,
        });
      if (materialId)
        await unlink(join(root, "data/materials", materialId)).catch(() => {});
      for (const key of envKeys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

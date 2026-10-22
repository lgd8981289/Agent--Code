import "dotenv/config";
import { chromium } from "playwright";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

// 手动真实供应商验收，会产生 DeepSeek 和百炼费用。使用独立数据库、端口和浏览器。
if (!process.argv.includes("--live"))
  throw new Error(
    "此脚本调用真实模型；先 npm run build，再 node scripts/browser-ai-audio.mjs --live",
  );
if (!process.env.DEEPSEEK_API_KEY || !process.env.DASHSCOPE_API_KEY)
  throw new Error("请先按 README 配置 DeepSeek 与百炼");
const databaseUrl =
  process.env.POSTGRES_URI ||
  "postgresql://aftersales_course:aftersales_course@127.0.0.1:5441/aftersales_agent";
const admin = new Pool({ connectionString: databaseUrl });
const name = "af_live_" + randomUUID().replaceAll("-", "");
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(databaseUrl);
url.pathname = "/" + name;
const db = new Pool({ connectionString: url.href });
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = "http://127.0.0.1:" + port;
const service = spawn(process.execPath, ["dist/server/main.js"], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    POSTGRES_URI: url.href,
    PORT: String(port),
    WEB_PORT: String(port),
    NODE_ENV: "production",
    COOKIE_SECURE: "false",
  },
});
let logs = "",
  browser;
service.stdout.on("data", (bytes) => {
  logs += bytes;
});
service.stderr.on("data", (bytes) => {
  logs += bytes;
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir("test-artifacts", { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (service.exitCode !== null) throw new Error("隔离服务启动失败");
    await delay(250);
  }
  assert.ok(ready, "隔离服务应启动");
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1512, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  const starter = page.getByRole("button", {
    name: "咖啡机到货损坏，申请退款",
    exact: true,
  });
  await starter.waitFor();
  const post = async (path, data = {}) => {
    const response = await page.request.post(base + "/api" + path, { data });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  // 先用 Replay 准备一笔合法的待审申请，再在新 AI 会话复现用户原句。
  const seed = await post("/conversations", { mode: "replay" });
  const c = await post(`/conversations/${seed.id}/messages`, {
    message: "A1024 咖啡机外壳裂了，我想申请退款。",
  });
  const material = await post(`/conversations/${c.id}/sample`);
  await post(`/materials/${material.id}/confirm`, {
    observation: material.observation,
  });
  const updated = await (
    await page.request.get(base + `/api/conversations/${c.id}`)
  ).json();
  await post(`/conversations/${c.id}/submit`, {
    orderId: "A1024",
    draftVersion: updated.draftVersion,
    amountCents: 350000,
    reason: "到货外壳裂了，申请退款。",
    fault: "none",
  });
  await page.reload();
  await page.getByLabel("运行模式").selectOption("ai");
  await starter.waitFor();
  const start = Date.now();
  await starter.click();
  await page.locator(".streaming-answer").waitFor({ timeout: 150000 });
  const firstTextMs = Date.now() - start;
  await page.screenshot({
    path: "test-artifacts/consultation-live-stream.png",
    fullPage: true,
  });
  await page.locator(".working").waitFor({ state: "hidden", timeout: 150000 });
  const { rows } = await db.query(
    "SELECT data FROM af_records WHERE kind='conversation' AND data->>'mode'='ai' ORDER BY updated_at DESC LIMIT 1",
  );
  const final = rows[0].data;
  assert.equal(final.messages.at(-1).status, "accepted", final.messages.at(-1).content);
  assert.ok(final.evidence.some((p) => p.id === "POL-DAMAGE-V3"));
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM af_records WHERE kind='case'"))
      .rows[0].n,
    1,
  );
  console.log(
    JSON.stringify({
      liveAI: "PASS",
      firstTextMs,
      totalMs: Date.now() - start,
      sources: final.evidence.map((p) => p.id),
    }),
  );

  const speak = page.getByRole("button", { name: "朗读", exact: true }).last();
  await speak.click();
  await page.locator(".speech-player audio").waitFor({ timeout: 100000 });
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 0.2,
    {},
    { timeout: 15000 },
  );
  const audio = await page.locator("audio").evaluate((a) => ({
    duration: a.duration,
    currentTime: a.currentTime,
    readyState: a.readyState,
    paused: a.paused,
    muted: a.muted,
    volume: a.volume,
    source: a.currentSrc.split(":")[0],
  }));
  assert.ok(Number.isFinite(audio.duration) && audio.duration > 0);
  assert.equal(audio.paused, false);
  assert.equal(audio.muted, false);
  // 复用这次真实音频做后续浏览器故障模拟，不再请求供应商。
  const bytes = Buffer.from(
    await page
      .locator("audio")
      .evaluate(async (a) =>
        Array.from(new Uint8Array(await (await fetch(a.currentSrc)).arrayBuffer())),
      ),
  );
  await page.screenshot({
    path: "test-artifacts/consultation-live-audio.png",
    fullPage: true,
  });
  const stop = () =>
    page
      .locator(".speech-player")
      .getByRole("button", { name: "停止朗读", exact: true })
      .click();
  await stop();
  assert.equal(await page.locator("audio").count(), 0);
  console.log(JSON.stringify({ liveTTS: "PASS", audio }));

  await page.route("**/api/voice/speak", (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: bytes }),
  );
  await page.evaluate(() => {
    window.originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    };
  });
  await speak.click();
  await page.getByText("语音已就绪，请点击播放器的播放按钮", { exact: true }).waitFor();
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = window.originalPlay;
  });
  await page.locator("audio").evaluate((a) => a.play());
  await page.waitForFunction(() => document.querySelector("audio")?.currentTime > 0.1);
  await stop();
  await page.unroute("**/api/voice/speak");
  await page.route("**/api/voice/speak", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ message: "验证用：音频下载失败" }),
    }),
  );
  await speak.click();
  await page.getByRole("alert").getByText("验证用：音频下载失败").waitFor();
  assert.equal(await page.locator("audio").count(), 0);
  await page.unroute("**/api/voice/speak");
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/voice/speak", async (route) => {
    await pending;
    await route
      .fulfill({ status: 200, contentType: "audio/wav", body: bytes })
      .catch(() => {});
  });
  await speak.click();
  await page.getByText("正在生成语音…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消朗读", exact: true }).click();
  release();
  await delay(300);
  assert.equal(await page.locator("audio").count(), 0, "取消后迟到的响应不得开始播放");
  assert.deepEqual(errors, []);
  console.log(
    "PASS：自动播放受限后的手动播放、停止、音频错误提示和生成中取消；原有申请未改动。",
  );
} catch (error) {
  await writeFile("test-artifacts/live-check-server.log", logs);
  throw error;
} finally {
  await browser?.close();
  const files = await db
    .query("SELECT id FROM af_records WHERE kind='material'")
    .catch(() => ({ rows: [] }));
  try {
    process.kill(-service.pid, "SIGTERM");
  } catch {}
  if (service.exitCode === null)
    await Promise.race([
      new Promise((resolve) => service.once("exit", resolve)),
      delay(5000),
    ]);
  await db.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
  await Promise.allSettled(files.rows.map((f) => unlink("data/materials/" + f.id)));
}

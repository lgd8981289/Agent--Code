import { verifyVoiceAndPolling } from "./browser-quality.mjs";
import { chromium } from "playwright";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import "dotenv/config";

// 使用独立数据库和独立端口，保留正在演示的项目数据。
const name = "af_browser_" + randomUUID().replaceAll("-", "");
const url = new URL(
  process.env.POSTGRES_URI ||
    "postgresql://aftersales_course:aftersales_course@127.0.0.1:5441/aftersales_agent",
);
const admin = new Pool({ connectionString: url.href });
await admin.query(`CREATE DATABASE "${name}"`);
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
    DEEPSEEK_API_KEY: "",
    DASHSCOPE_API_KEY: "",
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
const files = [];
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
    if (service.exitCode !== null) throw new Error(logs);
    await delay(250);
  }
  assert.ok(ready, "隔离浏览器服务应成功启动");
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1000 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const idle = () =>
    page.waitForFunction(
      () =>
        !document.querySelector(".working") &&
        !document.querySelector('select[aria-label="当前演示账号"]')?.disabled,
    );
  const shot = (name) =>
    page.screenshot({
      path: "test-artifacts/usability-" + name + ".png",
      fullPage: true,
    });
  const request = (path, body) =>
    page.evaluate(
      async ({ path, body }) => {
        const response = await fetch("/api" + path, {
          method: body ? "POST" : "GET",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, data: await response.json() };
      },
      { path, body },
    );
  await page.goto(base);
  await page
    .getByRole("button", { name: "咖啡机到货损坏，申请退款", exact: true })
    .click();
  await page.getByText("已核实订单", { exact: true }).waitFor();
  await idle();
  await page.getByTitle("重命名会话").click();
  await page.getByLabel("会话名称", { exact: true }).fill("咖啡机售后核对");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await page.getByRole("heading", { name: "咖啡机售后核对", exact: true }).waitFor();
  await idle();
  await page.getByRole("button", { name: "添加演示照片", exact: true }).click();
  await page.getByRole("button", { name: "确认这份材料", exact: true }).waitFor();
  await idle();
  await page.getByRole("button", { name: "添加演示照片", exact: true }).click();
  await idle();
  assert.equal(await page.locator(".material-item").count(), 1);
  await page.getByTitle(/移除材料/).click();
  await page.getByRole("button", { name: "确认移除", exact: true }).click();
  await page.getByText("还没有上传材料。", { exact: true }).waitFor();
  await idle();
  await page.getByRole("button", { name: "添加演示照片", exact: true }).click();
  await page.getByRole("button", { name: "确认这份材料", exact: true }).click();
  await idle();
  const accepted = page.getByRole("checkbox");
  await accepted.check();
  await page.getByLabel("问题说明", { exact: true }).fill("咖啡机外壳裂开，申请退款");
  assert.equal(await accepted.isChecked(), false, "修改申请后必须重新勾选确认");
  await accepted.check();
  await page
    .getByRole("button", { name: "确认申请，提交企业审核", exact: true })
    .click();
  await page.getByRole("button", { name: "撤回申请", exact: true }).waitFor();
  await idle();
  let item = (await request("/cases?query=A1024")).data.items[0];
  await shot("customer-case");
  await page.getByRole("button", { name: "撤回申请", exact: true }).click();
  await page.getByLabel("撤回原因", { exact: true }).fill("材料需要重新整理");
  await page.getByRole("button", { name: "确认撤回", exact: true }).click();
  await page.locator(".section-head .status.cancelled").waitFor();
  assert.equal((await request("/cases/" + item.id)).data.status, "cancelled");
  await page.getByLabel("申请状态").selectOption("cancelled");
  await page.getByLabel("搜索申请").fill(item.number);
  await page.waitForFunction(
    () =>
      document.querySelector(".case-filters > small")?.textContent === "共 1 条申请",
  );
  await shot("cancelled-filter");
  await page.getByRole("button", { name: "售后沟通", exact: true }).click();
  await page.getByTitle("新建会话").click();
  await page
    .getByRole("button", { name: "咖啡机到货损坏，申请退款", exact: true })
    .click();
  await page.getByText("已核实订单", { exact: true }).waitFor();
  await idle();
  await page.getByRole("button", { name: "添加演示照片", exact: true }).click();
  await page.getByRole("button", { name: "确认这份材料", exact: true }).click();
  await idle();
  await accepted.check();
  await page
    .getByRole("button", { name: "确认申请，提交企业审核", exact: true })
    .click();
  await page.getByRole("button", { name: "撤回申请", exact: true }).waitFor();
  await idle();
  await page.getByLabel("当前演示账号").selectOption("reviewer");
  await page.getByRole("button", { name: "批准并执行", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "退回补充", exact: true }).isDisabled(),
    true,
  );
  await page.getByPlaceholder("填写审核意见或需要补充的材料").fill("请补充外包装照片");
  await page.getByRole("button", { name: "退回补充", exact: true }).click();
  await shot("review-confirm");
  await page.getByRole("button", { name: "确认退回补充", exact: true }).click();
  await page.locator(".section-head .needs_materials").waitFor();
  await idle();
  await page.getByLabel("当前演示账号").selectOption("lin");
  await idle();
  // 删除已关联申请的聊天，不应让售后申请丢失；从申请可以重新打开。
  await page.locator(".conversation-item.active .delete-conversation").click();
  await page.getByRole("dialog", { name: "删除这条会话？" }).waitFor();
  assert.match(
    await page.getByRole("dialog", { name: "删除这条会话？" }).innerText(),
    /申请不会被撤回/,
  );
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await idle();
  await page.getByRole("button", { name: /我的申请/ }).click();
  await page.getByRole("button", { name: /返回原会话补充材料/ }).click();
  await idle();
  assert.equal(await page.locator(".conversation-item").count(), 2);
  await page.getByRole("button", { name: /我的申请/ }).click();
  await page.getByRole("button", { name: "确认修改并重新送审", exact: true }).waitFor();
  await page
    .getByLabel("问题说明", { exact: true })
    .fill("已补充外包装说明，包装内部破损");
  await page.getByRole("button", { name: "确认修改并重新送审", exact: true }).click();
  await page.locator(".section-head .waiting_review").waitFor();
  await idle();
  await page.getByLabel("当前演示账号").selectOption("reviewer");
  await page.getByRole("button", { name: "批准并执行", exact: true }).click();
  await page.getByRole("dialog", { name: "确认批准并执行" }).waitFor();
  assert.match(
    await page.getByRole("dialog", { name: "确认批准并执行" }).innerText(),
    /v2/,
  );
  await page.getByRole("button", { name: "确认批准并执行", exact: true }).click();
  await page.getByRole("heading", { name: "模拟退款已完成", exact: true }).waitFor();
  await idle();
  assert.equal(
    await page.getByRole("button", { name: "批准并执行", exact: true }).count(),
    0,
  );
  assert.ok((await page.locator(".history-entry").count()) >= 4);
  await page.locator(".history-entry details").first().click();
  await shot("audit-history");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTitle("下载申请与执行报告").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /report.json$/);
  // 连接中断不能继续显示“已连接”，恢复后可以重新读取。
  await context.setOffline(true);
  await page.getByTitle("刷新申请").click();
  await page
    .getByText("服务连接中断，当前显示的是上次读取的记录。", { exact: true })
    .waitFor();
  await shot("offline");
  await context.setOffline(false);
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".connection-banner"));
  // 清空 cookie 模拟过期，保留当前身份提示，用户主动重新登录。
  await context.clearCookies();
  await page.getByTitle("刷新申请").click();
  await page.getByText("登录已过期，请重新进入当前账号。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重新登录", exact: true }).click();
  await page.getByRole("button", { name: "质量验证", exact: true }).waitFor();
  await idle();
  // 同组任务的版本对比与报告快照通过真实评测入口生成。
  await page.getByRole("button", { name: "质量验证", exact: true }).click();
  await page.getByLabel("执行方式", { exact: true }).selectOption("replay");
  await page.getByRole("button", { name: "开始回归验证", exact: true }).click();
  await page.getByRole("button", { name: "开始回归验证", exact: true }).waitFor();
  await page.locator(".evaluation-stats").waitFor();
  await idle();
  const currentReportId = await page
    .getByLabel("历史报告", { exact: true })
    .inputValue();
  assert.match(await page.locator(".evaluation-stats").innerText(), /10/);
  await page.getByLabel("被测版本", { exact: true }).selectOption("baseline");
  await page.getByRole("button", { name: "开始回归验证", exact: true }).click();
  await page.getByRole("button", { name: "开始回归验证", exact: true }).waitFor();
  await idle();
  await page.getByLabel("对比报告", { exact: true }).selectOption(currentReportId);
  assert.equal(
    await page.locator(".comparison-table").getByText("退步", { exact: true }).count(),
    1,
  );
  await page.getByText("本次配置快照", { exact: true }).click();
  await shot("evaluation-comparison");
  await page.getByLabel("执行方式", { exact: true }).selectOption("ai");
  assert.equal(
    await page.getByLabel("被测版本", { exact: true }).inputValue(),
    "current",
  );
  await page.getByText("模型与提示词配置", { exact: true }).click();
  await shot("evaluation-ai-config");
  await page.getByRole("button", { name: "审核工作台", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("mobile");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await page.getByLabel("当前演示账号").selectOption("lin");
  await page.getByRole("button", { name: "售后沟通", exact: true }).click();
  await page.getByLabel("售后问题").fill("未发送的客户资料");
  await page.getByLabel("当前演示账号").selectOption("chen");
  await idle();
  assert.equal(await page.getByLabel("售后问题").inputValue(), "");
  assert.equal(await page.getByText("咖啡机售后核对", { exact: true }).count(), 0);
  await page.setViewportSize({ width: 1512, height: 1000 });
  // 新账号的两条会话：从左侧改名/删除另一条，不切换当前会话或清空草稿。
  await page.getByTitle("新建会话").click();
  await idle();
  await page.getByTitle("重命名会话", { exact: true }).click();
  await page.getByLabel("会话名称", { exact: true }).fill("第一条会话");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await idle();
  await page.getByTitle("新建会话").click();
  await idle();
  await page.getByLabel("售后问题").fill("这条草稿需要保留");
  await page.getByTitle("重命名：第一条会话", { exact: true }).click();
  await page.getByLabel("会话名称", { exact: true }).fill("  ");
  assert.equal(
    await page.getByRole("button", { name: "保存名称", exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel("会话名称", { exact: true }).fill("耳机退货材料核对与处理进度");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await idle();
  assert.equal(await page.locator(".chat-header h1").innerText(), "新的售后沟通");
  assert.equal(await page.getByLabel("售后问题").inputValue(), "这条草稿需要保留");
  await page.getByLabel("搜索会话").fill("耳机");
  assert.equal(await page.locator(".conversation-item").count(), 1);
  await page.getByLabel("搜索会话").fill("不存在的名字");
  await page.getByText("没有找到匹配的会话。", { exact: true }).waitFor();
  await page.getByTitle("清空会话搜索").click();
  await page
    .getByTitle("删除会话：耳机退货材料核对与处理进度", { exact: true })
    .click();
  await shot("conversation-delete-confirm");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.locator(".conversation-item").count(), 2);
  // 服务端失败时，确认框保留错误；可以取消或重新执行。
  await page.route("**/api/conversations/*/delete", async (route) => {
    await delay(500);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "删除暂时失败，请重试" }),
    });
  });
  await page
    .getByTitle("删除会话：耳机退货材料核对与处理进度", { exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("button", { name: "正在处理…", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "取消", exact: true }).isDisabled(),
    true,
  );
  await page
    .locator("dialog[open] .dialog-error")
    .getByText("删除暂时失败，请重试", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".conversation-item").count(), 2);
  await page.unroute("**/api/conversations/*/delete");
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await idle();
  await page.getByText("会话已删除", { exact: true }).waitFor();
  assert.equal(await page.locator(".conversation-item").count(), 1);
  assert.equal(await page.getByLabel("售后问题").inputValue(), "这条草稿需要保留");
  await page.getByTitle("删除会话：新的售后沟通", { exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await idle();
  assert.equal(await page.locator(".conversation-item").count(), 0);
  assert.equal(await page.getByLabel("售后问题").inputValue(), "");
  await page
    .getByRole("heading", { name: "说说遇到了什么问题", exact: true })
    .waitFor();
  await page.reload();
  await page.getByTitle("新建会话").waitFor();
  await idle();
  assert.equal(await page.locator(".conversation-item").count(), 0);
  // 删除沟通偏好需要单独确认，取消后原值不变。
  await page.locator(".profile-button").click();
  await page.getByLabel("希望怎样沟通").fill("优先使用文字沟通");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await idle();
  await page.getByText("沟通偏好已保存", { exact: true }).waitFor();
  await page.locator(".profile-button").click();
  await page
    .getByRole("button", { name: "删除偏好并停止自动记忆", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "删除沟通偏好？" })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(
    (await request("/bootstrap")).data.preferences[0].value,
    "优先使用文字沟通",
  );
  await page
    .getByRole("button", { name: "删除偏好并停止自动记忆", exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除并停用", exact: true }).click();
  await idle();
  assert.equal((await request("/bootstrap")).data.preferences[0].blocked, true);
  await page.getByTitle("新建会话").click();
  await idle();
  await page.getByTitle("重命名会话", { exact: true }).click();
  await page
    .getByLabel("会话名称", { exact: true })
    .fill("耳机退货材料核对与处理进度跟进");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await idle();
  await shot("conversation-actions");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("conversation-mobile");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await page
    .getByTitle("删除会话：耳机退货材料核对与处理进度跟进", { exact: true })
    .click();
  await shot("conversation-mobile-confirm");
  assert.equal(
    await page.getByRole("button", { name: "确认删除", exact: true }).isVisible(),
    true,
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await verifyVoiceAndPolling(page);
  assert.deepEqual(errors, []);
  console.log(
    "PASS：会话搜索、逐条改名和删除、取消/失败重试/防重复提交、当前和非当前会话删除、最后一条空状态、关联申请返回、偏好删除确认，以及材料/审核/断线/移动端流程、评测快照与同样本版本对比。",
  );
} catch (error) {
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: "test-artifacts/usability-failure.png", fullPage: true })
    .catch(() => {});
  await writeFile("test-artifacts/usability-server.log", logs);
  throw error;
} finally {
  await browser?.close();
  try {
    const result = await db.query("SELECT id FROM af_records WHERE kind='material'");
    files.push(...result.rows.map((row) => row.id));
  } catch {}
  try {
    process.kill(-service.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") console.error("浏览器测试服务清理失败", error);
  }
  await Promise.race([
    new Promise((resolve) => service.once("exit", resolve)),
    delay(5000),
  ]);
  await db.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
  await Promise.allSettled(files.map((id) => unlink("data/materials/" + id)));
}

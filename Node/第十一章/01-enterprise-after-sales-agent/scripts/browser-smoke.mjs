import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import "dotenv/config";

const base = `http://127.0.0.1:${process.env.WEB_PORT || 5190}`;
const stage = process.argv[2] || "all";
await mkdir("test-artifacts", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
});
const errors = [];
const context = await browser.newContext({
  viewport: { width: 1512, height: 1000 },
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => {
  await page.screenshot({ path: `test-artifacts/${name}.png`, fullPage: true });
};
const overflow = async () =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "页面不应横向溢出",
  );
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByLabel("当前演示账号").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="当前演示账号"]')?.options.length > 0,
  );
  if (stage === "pending" || stage === "all") {
    await page.getByLabel("当前演示账号").selectOption("lin");
    await page.getByRole("button", { name: "售后沟通", exact: true }).click();
    await page.getByTitle("新建会话").click();
    await page
      .getByRole("button", { name: "咖啡机到货损坏，申请退款", exact: true })
      .click();
    await page
      .getByText("POL-DAMAGE-V3", { exact: true })
      .count()
      .catch(() => 0);
    await page.getByText("已核实订单", { exact: true }).waitFor();
    await page.getByRole("button", { name: "添加演示照片", exact: true }).click();
    await page.getByRole("button", { name: "确认这份材料", exact: true }).click();
    await page.getByRole("checkbox").check();
    await page.locator("details.demo-options summary").click();
    await page
      .locator("details.demo-options select")
      .selectOption("timeout_after_commit");
    await overflow();
    await shot("01-consultation");
    await page
      .getByRole("button", { name: "确认申请，提交企业审核", exact: true })
      .click();
    await page.getByText("等待审核", { exact: true }).first().waitFor();
    await shot("02-awaiting-approval");
    const bootstrap = await page.evaluate(async () =>
      fetch("/api/cases").then((r) => r.json()),
    );
    const item = bootstrap.items[0];
    await writeFile(
      "test-artifacts/browser-case.json",
      JSON.stringify({
        caseId: item.id,
        conversationId: item.conversationId,
        number: item.number,
      }),
    );
    if (stage === "pending") {
      console.log("PASS：咨询、照片核对、提交申请；等待服务重启后执行 continue 阶段。");
      process.exitCode = 0;
    }
  }
  if (stage !== "pending") {
    const saved = JSON.parse(
      await readFile("test-artifacts/browser-case.json", "utf8"),
    );
    await page.getByLabel("当前演示账号").selectOption("reviewer");
    await page.getByRole("button", { name: "质量验证", exact: true }).waitFor();
    await page.locator(".case-item").filter({ hasText: "A1024" }).first().click();
    const approval = page.getByRole("button", {
      name: "批准并执行",
      exact: true,
    });
    if (await approval.count()) {
      await approval.click();
      await page.getByRole("button", { name: "确认批准并执行", exact: true }).click();
      await page.getByText("结果待核对", { exact: true }).first().waitFor();
      await shot("03-reconcile");
    }
    const retry = page.getByRole("button", {
      name: "核对结果并继续",
      exact: true,
    });
    if (await retry.count()) await retry.click();
    await page.getByRole("heading", { name: "模拟退款已完成", exact: true }).waitFor();
    await shot("04-completed");
    await page.getByRole("button", { name: "材料调查", exact: true }).click();
    await page.getByRole("button", { name: "开始材料调查", exact: true }).click();
    await page.getByText("事实与政策核对", { exact: true }).waitFor();
    await shot("05-investigation");
    await page.getByRole("button", { name: "执行记录", exact: false }).click();
    await page.locator(".trace-head").first().click();
    await shot("06-trace");
    await page.getByRole("button", { name: "质量验证", exact: true }).click();
    await page.getByRole("button", { name: "开始回归验证", exact: true }).click();
    await page
      .getByRole("button", { name: "开始回归验证", exact: true })
      .waitFor({ timeout: 60000 });
    await page.getByText("通过", { exact: true }).first().waitFor({ timeout: 60000 });
    await shot("07-evaluation");
    await page.getByLabel("当前演示账号").selectOption("lin");
    await page.getByRole("button", { name: "沟通偏好", exact: false }).click();
    await page.getByPlaceholder("例如：优先使用文字沟通").fill("优先使用文字沟通");
    await page.getByRole("button", { name: "保存偏好", exact: true }).click();
    await page.getByRole("button", { name: "售后沟通", exact: true }).click();
    await page.getByTitle("新建会话").click();
    await page.getByLabel("售后问题").fill("帮我查一下上次售后申请的处理进度");
    await page.getByTitle("发送消息", { exact: true }).click();
    await page.getByText(new RegExp(saved.number)).first().waitFor();
    await shot("08-cross-session");
    await page.setViewportSize({ width: 390, height: 844 });
    await overflow();
    await shot("09-mobile");
    const result = await page.evaluate(
      async (id) => fetch(`/api/cases/${id}`).then((r) => r.json()),
      saved.caseId,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.attempts, 2);
    assert.ok(result.refund?.id);
    assert.deepEqual(errors, [], "浏览器运行时错误");
    console.log(
      "PASS：审批、响应丢失核对、材料调查、回归报告、偏好保存、跨会话与移动端。",
    );
  }
} finally {
  await browser.close();
}

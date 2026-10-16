import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = process.env.ARTIFACT_DIR || 'test-artifacts'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1,
})
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
async function waitDone() {
  const pending = page.waitForResponse(
    (res) => res.url().endsWith('/api/runs') && res.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '开始评测', exact: true }).click()
  const { id } = await (await pending).json()
  // 等到新批次的 GET 返回并显示；旧批次也可能已有 26 / 26。
  await page.waitForResponse((res) => res.url().endsWith(`/api/runs/${id}`))
  await page.waitForTimeout(100)
  await page.waitForFunction(
    () => document.querySelector('.report-heading')?.textContent?.includes('26 / 26'),
    { timeout: 20000 },
  )
}
try {
  await page.goto('http://127.0.0.1:5188/')
  await page.getByText('服务已连接', { exact: true }).waitFor()
  await page.screenshot({ path: `${output}/arena-start.png`, fullPage: true })
  await waitDone()
  let counts = await page.locator('.score>strong').allTextContents()
  assert.deepEqual(
    counts.map((s) => s.replace(/\s/g, '')),
    ['9/13', '13/13'],
  )
  await page.getByRole('button', { name: '发布检查', exact: true }).click()
  await page.getByText('当前测试集检查通过', { exact: true }).waitFor()
  await page.screenshot({ path: `${output}/arena-comparison.png`, fullPage: true })
  const amount = page.locator('tbody tr').filter({ hasText: '查询实付金额' })
  await amount.getByRole('button', { name: '未通过', exact: true }).click()
  await page
    .locator('.dialog .turn')
    .getByText('订单 A1024 的实付金额是 35 元。', { exact: true })
    .waitFor()
  await page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'buildToolMessage' }) })
    .locator('summary')
    .click()
  await page.screenshot({ path: `${output}/arena-trace.png`, fullPage: false })
  await page.locator('.dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: /发现连续对话退步/ }).click()
  await waitDone()
  assert.deepEqual(
    (await page.locator('.score>strong').allTextContents()).map((s) => s.replace(/\s/g, '')),
    ['13/13', '12/13'],
  )
  await page.getByRole('button', { name: '发布检查', exact: true }).click()
  await page.getByText('发布检查未通过', { exact: true }).waitFor()
  await page.getByLabel('结果筛选').selectOption('changed')
  await page.screenshot({ path: `${output}/arena-regression.png`, fullPage: true })
  await page.getByRole('button', { name: /检查安全失败/ }).click()
  await waitDone()
  assert.deepEqual(
    (await page.locator('.score>strong').allTextContents()).map((s) => s.replace(/\s/g, '')),
    ['13/13', '9/13'],
  )
  await page.getByRole('button', { name: '发布检查', exact: true }).click()
  await page.getByText('4 条样本违反安全要求', { exact: true }).waitFor()
  await page.getByLabel('结果筛选').selectOption('security')
  await page.screenshot({ path: `${output}/arena-safety.png`, fullPage: true })
  // 版本创建只验证浏览器交互；接口持久化由隔离目录里的服务测试覆盖。
  let browserVersion
  await page.route('**/api/versions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    browserVersion = {
      ...route.request().postDataJSON(),
      id: 'browser-only-validation-version',
      createdAt: new Date().toISOString(),
    }
    await route.fulfill({ status: 201, json: browserVersion })
  })
  await page.route('**/api/meta', async (route) => {
    const response = await route.fetch()
    const meta = await response.json()
    if (browserVersion) meta.versions.push(browserVersion)
    await route.fulfill({ response, json: meta })
  })
  await page.getByRole('button', { name: /Agent 版本/ }).click()
  await page.getByRole('button', { name: '复制为新版本' }).nth(1).click()
  await page.getByLabel('版本名称').fill('浏览器验证 · 新候选版本')
  await page.getByRole('button', { name: '保存新版本', exact: true }).click()
  await page.locator('.overlay').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: /测试数据集/ }).click()
  assert.equal(await page.locator('tbody tr').count(), 13)
  await page.locator('tbody tr').first().getByRole('button', { name: '查看输入与检查要求' }).click()
  await page.getByText('评分器读取的要求', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '返回评测' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${output}/arena-mobile.png`, fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: '通过', exact: true })
    .first()
    .click()
  await page.screenshot({ path: `${output}/arena-mobile-detail.png`, fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(errors, [])
  console.log('UI 验证通过：金额错误、连续追问退步、安全失败门禁、版本创建、样本查看、移动端布局。')
} finally {
  await browser.close()
}

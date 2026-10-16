import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = process.env.ARTIFACT_DIR || 'test-artifacts/version-guidance'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
let includeCustom = true
page.on('pageerror', (error) => errors.push(error.message))
try {
  // 仅在浏览器内补一份自定义版本，不修改服务端数据或启动模型调用。
  await page.route('**/api/meta', async (route) => {
    const response = await route.fetch()
    const meta = await response.json()
    if (includeCustom) meta.versions.push({
      ...meta.versions.find((v) => v.id === 'baseline'),
      id: 'ui-custom-version',
      name: '测试用自定义版本',
    })
    await route.fulfill({ response, json: meta })
  })
  await page.goto('http://127.0.0.1:5188/')
  await page.getByText('服务已连接', { exact: true }).waitFor()
  const a = page.locator('#baseline-version')
  const b = page.locator('#candidate-version')
  const start = page.getByRole('button', { name: '开始评测', exact: true })
  assert.match(await page.locator('.scenario-brief').innerText(), /订单金额是 3500 元/)
  assert.match(await page.locator('#baseline-behavior').innerText(), /除以 100/)
  assert.match(await page.locator('#candidate-behavior').innerText(), /3500 元 → 交给回答步骤 3500 元/)
  await page.screenshot({ path: `${output}/amount-desktop.png`, fullPage: true })

  await b.selectOption('baseline')
  assert.equal(await start.isDisabled(), true)
  await page.locator('#same-version-warning').waitFor()
  assert.equal(await page.locator('.scenario-brief').count(), 0)
  await page.screenshot({ path: `${output}/same-version-warning.png`, fullPage: true })
  await b.selectOption('fixed')
  assert.equal(await start.isEnabled(), true)
  assert.equal(await page.locator('#same-version-warning').count(), 0)

  await page.getByRole('button', { name: /发现连续对话退步/ }).click()
  assert.equal(await a.inputValue(), 'fixed')
  assert.equal(await b.inputValue(), 'regression')
  assert.match(await page.locator('.scenario-brief').innerText(), /第 2 轮：这笔订单/)
  assert.match(await page.locator('#candidate-behavior').innerText(), /清空历史/)
  await page.getByRole('button', { name: /检查安全失败/ }).click()
  assert.match(await page.locator('#candidate-behavior').innerText(), /跳过订单归属/)
  assert.match(await page.locator('.scenario-brief').innerText(), /实际退款记录必须保持为空/)

  await page.getByRole('button', { name: /定位金额错误/ }).click()
  await page.getByRole('button', { name: /已选 13 \/ 13 条样本/ }).click()
  await page.getByRole('checkbox', { name: '查询实付金额', exact: true }).uncheck()
  await page.getByRole('button', { name: '返回评测' }).click()
  await page.getByText('此代表任务未选中，本次不会执行。', { exact: true }).waitFor()
  assert.match(await page.locator('.config-bottom').innerText(), /共 24 次样本执行/)
  await page.getByRole('button', { name: /定位金额错误/ }).click()

  await b.selectOption('ui-custom-version')
  assert.equal(await page.locator('.scenario-brief').count(), 0)
  assert.match(await page.locator('#candidate-behavior').innerText(), /除以 100/)
  await page.getByRole('button', { name: /Agent 版本/ }).click()
  const fixedRow = page.locator('tbody tr').filter({ hasText: 'v2 · 完整流程' }).first()
  assert.match(await fixedRow.innerText(), /保留工具查回来的原始金额/)
  assert.match(await fixedRow.innerText(), /实际行为/)
  assert.match(await fixedRow.innerText(), /具体例子/)
  assert.match(await fixedRow.innerText(), /评测目的/)
  assert.match(await fixedRow.innerText(), /真实模型仍可能答错/)
  await fixedRow.getByRole('button', { name: '复制为新版本' }).click()
  await page.getByLabel('流程配置').selectOption('drop-history')
  assert.match(await page.locator('.form-behavior').innerText(), /清空历史/)
  assert.match(await page.locator('.form-behavior').innerText(), /连续追问是否已经退步/)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.route('**/api/versions/ui-custom-version', async (route) => {
    assert.equal(route.request().method(), 'DELETE')
    includeCustom = false
    await route.fulfill({ json: { id: 'ui-custom-version' } })
  })
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '删除版本：测试用自定义版本', exact: true }).click()
  await page.getByRole('button', { name: '删除版本：测试用自定义版本', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await fixedRow.getByRole('button', { name: /删除版本/ }).count(), 0)
  await page.screenshot({ path: `${output}/version-configurations.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 900 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.getByRole('button', { name: /定位金额错误/ }).click()

  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(async () => {
      window.scrollTo(0, 0)
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const aBounds = await page.locator('.version-choice').nth(0).boundingBox()
    const bBounds = await page.locator('.version-choice').nth(1).boundingBox()
    const gap = width <= 720 ? bBounds.y - (aBounds.y + aBounds.height) : bBounds.x - (aBounds.x + aBounds.width)
    assert.ok(gap >= 0, `版本说明重叠：${width}px`)
    if (width === 390) await page.screenshot({ path: `${output}/amount-mobile.png`, fullPage: true })
  }
  assert.deepEqual(errors, [])
  console.log('配置界面验证通过：三场景、四类行为、同版本提示、自定义版本、样本范围及桌面/移动端。未创建评测或修改服务端数据。')
} finally {
  await browser.close()
}

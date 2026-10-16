import { test } from 'node:test'
import assert from 'node:assert/strict'
import { builtinDataset, builtinVersions } from '../server/dataset.js'
import { getDemoScenario, versionBehaviors } from '../shared/evaluation-guide.js'

const dataset = builtinDataset()
const [baseline, fixed, regression, unsafe] = builtinVersions()

test('每种流程配置都有具体行为说明，自定义版本复用配置对应说明', () => {
  for (const version of builtinVersions()) {
    assert.ok(versionBehaviors[version.fault].description.length > 20)
    assert.ok(versionBehaviors[version.fault].example)
    assert.ok(versionBehaviors[version.fault].walkthrough.length > 30)
    assert.ok(versionBehaviors[version.fault].evaluation.length > 15)
    assert.ok(versionBehaviors[version.fault].note)
  }
  const custom = { ...baseline, id: 'custom', name: '我的版本' }
  assert.match(versionBehaviors[custom.fault].description, /除以 100/)
  assert.match(versionBehaviors[custom.fault].example, /3500 元.*35 元/)
  assert.match(versionBehaviors[fixed.fault].example, /3500 元.*3500 元/)
  assert.match(versionBehaviors[fixed.fault].note, /真实模型仍可能答错/)
  assert.match(versionBehaviors[unsafe.fault].note, /仅允许 Replay/)
})

test('教学场景跟随当前版本组合，代表任务来自实际数据集', () => {
  const amount = getDemoScenario(baseline, fixed, dataset)!
  assert.equal(amount.title, '定位金额错误')
  assert.equal(amount.sample, dataset.cases.find((c) => c.id === 'amount'))
  assert.equal(getDemoScenario(fixed, regression, dataset)?.sample.turns.length, 2)
  assert.equal(getDemoScenario(fixed, unsafe, dataset)?.sample.category, 'security')
})

test('相同版本、自定义版本、不同数据集和加载中不显示不适用的教学场景', () => {
  assert.equal(getDemoScenario(baseline, baseline, dataset), null)
  assert.equal(getDemoScenario(fixed, baseline, dataset), null)
  assert.equal(getDemoScenario(baseline, { ...fixed, id: 'custom' }, dataset), null)
  assert.equal(getDemoScenario(baseline, fixed, { ...dataset, builtin: false }), null)
  assert.equal(getDemoScenario(baseline, fixed, { ...dataset, cases: [] }), null)
  assert.equal(getDemoScenario(undefined, fixed, dataset), null)
  assert.equal(getDemoScenario(baseline, fixed, undefined), null)
})

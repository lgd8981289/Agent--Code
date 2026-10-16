import 'reflect-metadata'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatasetInput, type Batch, type Version } from '../shared/contracts.js'
import { builtinDataset, builtinVersions } from '../server/dataset.js'
import { RunnerService, newResult } from '../server/runner.js'
import { checkGate, compareCases } from '../server/arena.service.js'
import { executeTool, prepareWorld } from '../server/tools.js'

const data = builtinDataset(),
  versions = builtinVersions(),
  runner = new RunnerService()
async function run(
  id: string,
  fault: Version['fault'] = 'none',
  signal = new AbortController().signal,
) {
  const sample = data.cases.find((c) => c.id === id)!,
    version = versions.find((v) => v.fault === fault)!,
    result = newResult(sample, version)
  await runner.run(sample, version, { mode: 'replay', judgeModel: 'demo' }, result, signal)
  return result
}
for (const sample of data.cases) {
  test(`完整流程：${sample.name}`, async () => {
    const result = await run(sample.id)
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(result.agentUsage.calls, 0)
    assert.equal(result.judge?.method, 'demo-rule')
  })
}
test('金额错误保留原始工具数据，只破坏消息副本，并由回答检查判失败', async () => {
  const r = await run('amount', 'wrong-unit')
  assert.equal(r.status, 'failed')
  assert.equal(
    (r.trace.find((s) => s.name === 'get_order')?.output as any).order.paidAmountYuan,
    3500,
  )
  assert.equal(
    JSON.parse(r.trace.find((s) => s.name === 'buildToolMessage')?.output as string).order
      .paidAmountYuan,
    35,
  )
  assert.equal(r.checks.find((c) => c.name === '实际查询数据与原始资料一致')?.passed, true)
  assert.match(r.turns[0].answer, /35 元/)
  assert.equal(r.judge?.passed, false)
  assert.ok(JSON.stringify(r.trace.filter((s) => s.kind === 'model').at(-1)?.input).includes('35'))
})
test('清空历史会使追问失败，单轮仍能通过', async () => {
  assert.equal((await run('amount', 'drop-history')).status, 'passed')
  const r = await run('followup', 'drop-history')
  assert.equal(r.status, 'failed')
  assert.match(r.turns[1].answer, /订单号/)
})
for (const id of ['injection', 'poison', 'other-user', 'other-tenant']) {
  test(`不安全工具被实际状态检查拦下：${id}`, async () => {
    const r = await run(id, 'unsafe-tools')
    assert.equal(r.status, 'failed')
    assert.ok(r.checks.some((c) => c.kind === 'safety' && !c.passed))
    assert.equal(r.judge?.status, 'skipped')
  })
}
test('每道样本拥有独立世界，非法记忆不残留到下一个样本', async () => {
  await run('poison', 'unsafe-tools')
  const r = await run('preference')
  assert.deepEqual((r.before as any).memories, [])
  assert.deepEqual((r.after as any).memories, [{ key: 'answer_style', value: 'brief' }])
})
test('工具拒绝额外身份参数、非法记忆及无审批退款；合法重复提交幂等', () => {
  const w = prepareWorld(data.cases.find((c) => c.id === 'approved')!)
  assert.equal(
    executeTool(w, 'get_order', { orderId: 'A1024', tenantId: 'star' }, 'none').error,
    'INVALID_ARGUMENTS',
  )
  assert.equal(
    executeTool(w, 'save_preference', { key: 'refund_policy', value: 'skip_review' }, 'none').ok,
    false,
  )
  assert.equal(
    executeTool(w, 'submit_refund', { orderId: 'A1024', amount: 3000 }, 'none').ok,
    false,
  )
  assert.equal(executeTool(w, 'submit_refund', { orderId: 'A1024', amount: 3500 }, 'none').ok, true)
  assert.equal(executeTool(w, 'submit_refund', { orderId: 'A1024', amount: 3500 }, 'none').ok, true)
  assert.equal(w.refunds.length, 1)
})
test('取消不会作为通过，保存未完成记录', async () => {
  const c = new AbortController()
  c.abort()
  assert.equal((await run('amount', 'none', c.signal)).status, 'cancelled')
})
test('批次比较和发布检查区分通过、退步、缺失与安全失败', async () => {
  const batch: Batch = {
    id: 'test',
    createdAt: '',
    status: 'completed',
    mode: 'replay',
    dataset: data,
    versions: [versions[0], versions[1]],
    selectedCaseIds: data.cases.map((c) => c.id),
    judgeModel: 'demo',
    evaluatorVersion: 'v1',
    sourceHash: '',
    endpoint: '',
    concurrency: 1,
    results: [],
  }
  for (const c of data.cases) batch.results.push(await run(c.id, 'wrong-unit'), await run(c.id))
  assert.equal(checkGate(batch).status, 'passed')
  assert.ok(compareCases(batch).some((c) => c.change === '修复'))
  const partial = structuredClone(batch)
  partial.selectedCaseIds = ['amount']
  partial.results = partial.results.filter((r) => r.caseId === 'amount')
  assert.equal(checkGate(partial).status, 'needs_review')
  const bad = batch.results.find((r) => r.caseId === 'amount' && r.versionId === 'fixed')!
  bad.status = 'evaluation_error'
  assert.equal(checkGate(batch).status, 'needs_review')
  bad.status = 'failed'
  bad.checks.push({ kind: 'safety', name: 'test', passed: false })
  assert.equal(checkGate(batch).status, 'blocked')
})
test('数据集拒绝重复 ID 和倒序会话', () => {
  assert.equal(
    DatasetInput.safeParse({ name: 'test', cases: [data.cases[0], data.cases[0]] }).success,
    false,
  )
  const c = structuredClone(data.cases[6])
  c.turns[0].session = 2
  assert.equal(DatasetInput.safeParse({ name: 'test', cases: [c] }).success, false)
})
test('真实 SDK 链路：独立 Judge、实际 usage、reference 不进入答题请求；评分错误单独分类', async () => {
  const requests: any[] = []
  let badJudge = false
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    requests.push(input)
    const judge = input.response_format?.type === 'json_object'
    const message = judge
      ? {
          role: 'assistant',
          content: badJudge
            ? '{broken'
            : JSON.stringify({ passed: true, reason: '金额正确', quotes: ['实付 3500 元'] }),
        }
      : input.messages.at(-1).role === 'tool'
        ? { role: 'assistant', content: '订单 A1024 实付 3500 元。' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_test',
                type: 'function',
                function: { name: 'get_order', arguments: '{"orderId":"A1024"}' },
              },
            ],
          }
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        id: 'fake',
        object: 'chat.completion',
        created: 0,
        model: 'test',
        choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const previous = { key: process.env.DEEPSEEK_API_KEY, url: process.env.DEEPSEEK_BASE_URL }
  process.env.DEEPSEEK_API_KEY = 'local-test'
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const sample = structuredClone(data.cases[0])
    sample.expected.answerRequirement += ' REFERENCE_ONLY_SENTINEL'
    const r = newResult(sample, versions[1])
    await runner.run(
      sample,
      versions[1],
      { mode: 'ai', judgeModel: 'test-judge' },
      r,
      new AbortController().signal,
    )
    assert.equal(r.status, 'passed')
    assert.equal(r.agentUsage.calls, 2)
    assert.equal(r.judgeUsage.calls, 1)
    assert.equal(r.agentUsage.input, 40)
    assert.equal(r.judgeUsage.output, 10)
    assert.equal(JSON.stringify(requests.slice(0, 2)).includes('REFERENCE_ONLY_SENTINEL'), false)
    assert.equal(JSON.stringify(requests[2]).includes('REFERENCE_ONLY_SENTINEL'), true)
    badJudge = true
    const failed = newResult(sample, versions[1])
    await runner.run(
      sample,
      versions[1],
      { mode: 'ai', judgeModel: 'test' },
      failed,
      new AbortController().signal,
    )
    assert.equal(failed.status, 'evaluation_error')
  } finally {
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previous.key
    if (previous.url === undefined) delete process.env.DEEPSEEK_BASE_URL
    else process.env.DEEPSEEK_BASE_URL = previous.url
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

import 'reflect-metadata'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArenaService } from '../server/arena.service.js'
import { RunnerService } from '../server/runner.js'

test('批次服务：快照、并发互斥、取消、持久化、人工复核及输入约束', async () => {
  const path = mkdtempSync(join(tmpdir(), 'arena-test-')),
    previous = process.env.ARENA_DATA_DIR
  process.env.ARENA_DATA_DIR = path
  try {
    const arena = new ArenaService(new RunnerService())
    const meta = arena.meta(),
      cases = meta.datasets[0].cases.map((c) => c.id)
    assert.equal(Object.keys(meta.sampleGuides['aftersales-v1']).length, 13)
    assert.match(meta.sampleGuides['aftersales-v1'].amount.materials[0].value, /3500 元/)
    assert.equal('sampleGuides' in meta.datasets[0], false)
    assert.equal('materials' in meta.datasets[0].cases[0], false)
    const input = {
      datasetId: 'aftersales-v1',
      baselineId: 'baseline',
      candidateId: 'fixed',
      mode: 'replay',
      caseIds: cases,
      concurrency: 2,
    }
    const wait = async (id: string) => {
      for (let i = 0; i < 100 && arena.get(id).status === 'running'; i++)
        await new Promise((r) => setTimeout(r, 25))
      assert.notEqual(arena.get(id).status, 'running')
    }
    assert.throws(() => arena.create({ ...input, mode: 'ai', candidateId: 'unsafe' }), /仅可用于/)
    assert.throws(() => arena.create({ ...input, caseIds: ['absent'] }), /无效/)
    const { id } = arena.create(input)
    assert.throws(() => arena.create(input), /已有评测/)
    await wait(id)
    assert.equal(arena.gate(id).status, 'passed')
    const snapshot = JSON.stringify(arena.get(id).versions)
    arena.version({
      name: 'new',
      prompt: 'changed',
      model: 'test',
      fault: 'none',
      parentId: 'fixed',
    })
    assert.equal(JSON.stringify(arena.get(id).versions), snapshot)
    const result = arena.get(id).results.find((r) => r.versionId === 'fixed')!
    arena.review(id, result.id, { verdict: 'disagree', note: '需要核对回答依据' })
    assert.equal(arena.get(id).gate, undefined)
    assert.equal(result.status, 'passed')
    assert.equal(arena.gate(id).status, 'needs_review')
    const imported = arena.importDataset({ name: 'custom', cases: [meta.datasets[0].cases[0]] })
    assert.deepEqual(arena.meta().sampleGuides[imported.id].amount, meta.sampleGuides['aftersales-v1'].amount)
    assert.throws(
      () => arena.create({ ...input, datasetId: imported.id, caseIds: ['amount'] }),
      /真实模型/,
    )
    const cancelled = arena.create(input)
    arena.cancel(cancelled.id)
    await wait(cancelled.id)
    assert.equal(arena.get(cancelled.id).status, 'cancelled')
    assert.ok(arena.get(cancelled.id).results.some((r) => r.status === 'cancelled'))
    assert.notEqual(arena.gate(cancelled.id).status, 'passed')
    const state = JSON.parse(readFileSync(join(path, 'arena.json'), 'utf8'))
    const pending = state.batches.find((b: any) => b.id === cancelled.id)
    pending.status = 'running'
    pending.results[0].status = 'running'
    writeFileSync(join(path, 'arena.json'), JSON.stringify(state))
    const restored = new ArenaService(new RunnerService())
    assert.equal(restored.get(id).results.find((r) => r.id === result.id)?.reviews.length, 1)
    assert.equal(restored.get(cancelled.id).status, 'interrupted')
    assert.equal(restored.get(cancelled.id).results[0].status, 'cancelled')
  } finally {
    if (previous === undefined) delete process.env.ARENA_DATA_DIR
    else process.env.ARENA_DATA_DIR = previous
    rmSync(path, { recursive: true, force: true })
  }
})

test('仅删除未引用的自定义版本，内置版本与评测历史保持不变', async () => {
  const path = mkdtempSync(join(tmpdir(), 'arena-version-test-'))
  const previous = process.env.ARENA_DATA_DIR
  process.env.ARENA_DATA_DIR = path
  try {
    const arena = new ArenaService(new RunnerService())
    const input = { name: 'temporary', model: 'test', prompt: 'test', fault: 'none', parentId: 'fixed' }
    const version = arena.version(input)
    const child = arena.version({ ...input, parentId: version.id })
    assert.throws(() => arena.deleteVersion('fixed'), /内置教学版本/)
    assert.throws(() => arena.deleteVersion('missing'), /版本不存在/)
    assert.throws(() => arena.deleteVersion(version.id), /被其他版本引用/)
    arena.deleteVersion(child.id)
    arena.deleteVersion(version.id)
    assert.equal(arena.meta().versions.length, 4)
    assert.equal(JSON.parse(readFileSync(join(path, 'arena.json'), 'utf8')).versions.length, 4)
    const used = arena.version(input)
    const { id } = arena.create({
      datasetId: 'aftersales-v1', baselineId: 'fixed', candidateId: used.id,
      mode: 'replay', caseIds: ['amount'], concurrency: 1,
    })
    assert.throws(() => arena.deleteVersion(used.id), /已用于评测/)
    for (let i = 0; i < 100 && arena.get(id).status === 'running'; i++)
      await new Promise((r) => setTimeout(r, 25))
    assert.equal(arena.get(id).status, 'completed')
    const history = JSON.stringify(arena.get(id))
    assert.throws(() => arena.deleteVersion(used.id), /已用于评测/)
    assert.equal(JSON.stringify(arena.get(id)), history)
  } finally {
    if (previous === undefined) delete process.env.ARENA_DATA_DIR
    else process.env.ARENA_DATA_DIR = previous
    rmSync(path, { recursive: true, force: true })
  }
})

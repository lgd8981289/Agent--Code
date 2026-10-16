import { z } from 'zod'

export const Fault = z.enum(['none', 'wrong-unit', 'drop-history', 'unsafe-tools'])
export const VersionInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(8000),
    fault: Fault,
    parentId: z.string().optional(),
  })
  .strict()
export type Version = z.infer<typeof VersionInput> & { id: string; createdAt: string }
export const SampleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    name: z.string().min(1).max(120),
    category: z.enum(['normal', 'security', 'control']),
    turns: z
      .array(
        z
          .object({
            question: z.string().min(1).max(6000),
            session: z.number().int().min(1).max(5),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    fixture: z.object({ injectedDocument: z.boolean(), approved: z.boolean() }).strict(),
    expected: z
      .object({
        requiredTools: z.array(
          z.enum(['get_order', 'read_policy', 'save_preference', 'submit_refund']),
        ),
        orderId: z.string().nullable(),
        refunds: z.number().int().min(0).max(1),
        preference: z.enum(['brief', 'detailed']).nullable(),
        answerRequirement: z.string().min(1).max(4000),
      })
      .strict(),
  })
  .strict()
export const DatasetInput = z
  .object({ name: z.string().min(1).max(80), cases: z.array(SampleSchema).min(1).max(30) })
  .strict()
  .superRefine((d, ctx) => {
    if (new Set(d.cases.map((c) => c.id)).size !== d.cases.length)
      ctx.addIssue({ code: 'custom', message: '样本 ID 不能重复' })
    for (const c of d.cases) {
      if (
        c.turns[0].session !== 1 ||
        c.turns.some(
          (t, i) =>
            i > 0 && (t.session < c.turns[i - 1].session || t.session > c.turns[i - 1].session + 1),
        )
      ) {
        ctx.addIssue({ code: 'custom', message: `${c.id} 的 session 必须从 1 开始，保持或递增 1` })
      }
    }
  })
export type Sample = z.infer<typeof SampleSchema>
export type Dataset = z.infer<typeof DatasetInput> & {
  id: string
  createdAt: string
  hash: string
  builtin: boolean
}
export interface SampleGuide {
  materials: { label: string; value: string }[]
  context: string
  orders: { orderId: string; description: string; ownership: string; accessible: boolean }[]
  document: string
  approvals: string
  initialState: string
  conversation: string
  outcome: string
  rules: string[]
  safety: string[]
}
export type Mode = 'replay' | 'ai'
export type Status =
  'queued' | 'running' | 'passed' | 'failed' | 'agent_error' | 'evaluation_error' | 'cancelled'
export interface Span {
  id: string
  parentId: string | null
  name: string
  kind: string
  input: unknown
  output?: unknown
  durationMs: number
  error?: string
}
export interface Usage {
  calls: number
  input: number | null
  output: number | null
  durationMs: number
}
export interface Check {
  name: string
  kind: 'task' | 'safety'
  passed: boolean
}
export interface Turn {
  question: string
  session: number
  answer: string
}
export interface JudgeResult {
  method: 'demo-rule' | 'llm'
  status: 'completed' | 'skipped' | 'error'
  passed?: boolean
  reason: string
  quotes: string[]
}
export interface CaseResult {
  id: string
  caseId: string
  versionId: string
  status: Status
  turns: Turn[]
  checks: Check[]
  judge?: JudgeResult
  trace: Span[]
  before?: unknown
  after?: unknown
  error?: string
  agentUsage: Usage
  judgeUsage: Usage
  reviews: { at: string; verdict: 'agree' | 'disagree'; note: string }[]
}
export interface Gate {
  status: 'passed' | 'blocked' | 'needs_review'
  reasons: string[]
  checkedAt: string
}
export interface Batch {
  id: string
  createdAt: string
  status: 'running' | 'completed' | 'cancelled' | 'interrupted'
  mode: Mode
  dataset: Dataset
  versions: [Version, Version]
  selectedCaseIds: string[]
  judgeModel: string
  evaluatorVersion: string
  sourceHash: string
  endpoint: string
  concurrency: number
  results: CaseResult[]
  gate?: Gate
}
export const RunInput = z
  .object({
    datasetId: z.string(),
    baselineId: z.string(),
    candidateId: z.string(),
    mode: z.enum(['replay', 'ai']),
    caseIds: z.array(z.string()).min(1).max(30),
    concurrency: z.number().int().min(1).max(2).default(1),
  })
  .strict()
  .refine((v) => v.baselineId !== v.candidateId, '请选择两个不同版本')
export const faultLabels: Record<Version['fault'], string> = {
  none: '完整流程',
  'wrong-unit': '金额单位转换错误',
  'drop-history': '未保留连续对话',
  'unsafe-tools': '缺少工具安全校验（仅演示）',
}
export const statusLabels: Record<Status, string> = {
  queued: '待执行',
  running: '执行中',
  passed: '通过',
  failed: '未通过',
  agent_error: 'Agent 异常',
  evaluation_error: '评分异常',
  cancelled: '已取消',
}

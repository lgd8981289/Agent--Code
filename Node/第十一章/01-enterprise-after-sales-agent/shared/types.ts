export type Mode = "replay" | "ai";
export type Actor = {
  id: string;
  tenantId: string;
  name: string;
  role: "customer" | "reviewer";
};
export type Order = {
  id: string;
  tenantId: string;
  userId: string;
  product: string;
  paidCents: number;
  refundedCents: number;
  signedAt: string;
  tracking: string;
  deliveryStatus: string;
};
export type Policy = {
  id: string;
  tenantId: string;
  title: string;
  version: number;
  active: boolean;
  category: "eligibility" | "materials" | "approval";
  content: string;
  source: string;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  sourceIds?: string[];
  sources?: Policy[];
  status?: "accepted" | "error";
  runId?: string;
};
export type Proposal = {
  order: Order;
  amountCents: number;
  reason: string;
  sourceIds: string[];
  missing: string[];
  eligible: boolean;
};
export type Conversation = {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  mode: Mode;
  messages: Message[];
  proposal: Proposal | null;
  caseId: string | null;
  materialIds: string[];
  evidence?: Policy[];
  draftVersion?: number;
  customTitle?: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};
/** 列表只传展示字段，消息、材料与政策快照从详情接口读取。 */
export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "mode" | "caseId" | "createdAt" | "updatedAt"
> & { caseStatus: CaseStatus | null };
export type CaseStatus =
  | "waiting_review"
  | "needs_materials"
  | "approved"
  | "executing"
  | "unknown"
  | "completed"
  | "rejected"
  | "cancelled";
export type CaseHistory = {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  action: string;
  note: string;
  version: number;
  status: CaseStatus;
  amountCents: number;
  reason: string;
  materials: { id: string; name: string; observation: string }[];
};
export type CasePage = {
  items: AfterSalesCase[];
  total: number;
  page: number;
  pageSize: number;
  counts: Partial<Record<CaseStatus, number>>;
};
export type Review = {
  id: string;
  decision: "approve" | "revise" | "reject";
  note: string;
  reviewerId: string;
  version: number;
  at: string;
};
export type Refund = {
  id: string;
  requestKey: string;
  caseId: string;
  version: number;
  orderId: string;
  amountCents: number;
  status: "completed";
  at: string;
};
export type InvestigationFinding = {
  file: string;
  quote: string;
  finding: string;
};
export type Investigation = {
  id: string;
  mode: Mode;
  status: "running" | "completed" | "failed" | "stale";
  caseVersion?: number;
  inputHash?: string;
  staleReason?: string;
  facts: InvestigationFinding[];
  policies: InvestigationFinding[];
  summary: string;
  unresolved: string[];
  files: string[];
  error?: string;
  at: string;
};
export type AfterSalesCase = {
  id: string;
  number: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  orderId: string;
  product: string;
  paidCents: number;
  amountCents: number;
  reason: string;
  version: number;
  status: CaseStatus;
  materialIds: string[];
  sourceIds: string[];
  policySnapshots?: Policy[];
  reviews: Review[];
  refund: Refund | null;
  lastError: string | null;
  attempts: number;
  fault: "none" | "timeout_after_commit" | "before_submit";
  faultConsumed: boolean;
  investigation: Investigation | null;
  history?: CaseHistory[];
  cancelledAt?: string;
  cancellationReason?: string;
  createdAt: string;
  updatedAt: string;
};
export type Material = {
  id: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  name: string;
  mime: string;
  kind: "image" | "document";
  bytes: number;
  observation: string;
  confirmed: boolean;
  text?: string;
  mode: Mode;
  at: string;
  checksum?: string;
  removedAt?: string;
  orderId?: string;
};
export type Preference = {
  key: "communication_style";
  value: string;
  blocked: boolean;
  updatedAt: string;
};
export type Trace = {
  id: string;
  conversationId: string | null;
  caseId: string | null;
  tenantId: string;
  userId: string;
  parentId: string | null;
  kind: string;
  name: string;
  status: "completed" | "failed";
  input: unknown;
  output: unknown;
  durationMs: number;
  at: string;
};
export type EvaluationCheck = {
  status: "passed" | "failed" | "error";
  reason: string;
};
export type EvaluationItem = {
  mode?: Mode;
  rule?: EvaluationCheck;
  judge?: EvaluationCheck & { quotes: string[] };
  messages?: Message[];
  traces?: Trace[];
  id: string;
  name: string;
  status: "passed" | "failed" | "error";
  expected: string;
  actual: string;
  durationMs: number;
};
export type EvaluationReport = {
  id: string;
  at: string;
  mode: Mode;
  snapshot?: {
    datasetVersion: string;
    datasetHash: string;
    codeHash: string;
    knowledgeHash: string;
    model: string;
    judgeModel: string;
    prompt: string;
    safetyPrompt: string;
    promptHash: string;
    knowledgeBackend: string;
    retrievalConfig?: {
      embeddingModel: string;
      embeddingDimensions: number;
      rerankModel: string;
      collection: string;
    };
  };
  version: string;
  items: EvaluationItem[];
  passed: number;
  total: number;
  gate: "passed" | "blocked";
  scope: string;
};
export type Bootstrap = {
  actor: Actor;
  accounts: Actor[];
  aiReady: boolean;
  multimodalReady: boolean;
  orders: Order[];
  policies: Policy[];
  preferences: Preference[];
  model: string;
};
export const statusLabels: Record<CaseStatus, string> = {
  waiting_review: "等待审核",
  needs_materials: "补充材料",
  approved: "审核通过",
  executing: "执行中",
  unknown: "结果待核对",
  completed: "处理完成",
  rejected: "已拒绝",
  cancelled: "已撤回",
};
/** SSE 中的 answer 为临时显示内容；done 才是已保存的最终会话。 */
export type ConsultationEvent =
  | { type: "status"; message: string }
  | { type: "answer.reset" }
  | { type: "answer.delta"; text: string }
  | { type: "done"; conversation: Conversation }
  | { type: "error"; message: string };

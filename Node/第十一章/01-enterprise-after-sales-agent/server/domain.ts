import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import type {
  Actor,
  AfterSalesCase,
  Order,
  Refund,
  Review,
  CaseStatus,
} from "../shared/types.js";

export function assertOwner(
  actor: Actor,
  value: { tenantId: string; userId: string },
  allowReviewer = false,
) {
  if (
    actor.tenantId !== value.tenantId ||
    (!(allowReviewer && actor.role === "reviewer") && actor.id !== value.userId)
  )
    throw new ForbiddenException("无权访问这条记录");
}
export function assertCustomer(actor: Actor) {
  if (actor.role !== "customer") throw new ForbiddenException("请使用客户身份操作");
}
export function assertReviewer(actor: Actor) {
  if (actor.role !== "reviewer") throw new ForbiddenException("仅企业审核人员可以审批");
}
export function assertVersion(item: AfterSalesCase, version: number) {
  if (item.version !== version)
    throw new ConflictException("申请版本已经变化，请刷新后审核当前版本");
}
export function assertAmount(amountCents: number, order: Order) {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > order.paidCents - order.refundedCents
  )
    throw new BadRequestException("退款金额必须大于零，且不能超过订单剩余可退金额");
}
export function approvalFor(item: AfterSalesCase): Review | undefined {
  return [...item.reviews].reverse().find((r) => r.version === item.version);
}
export function assertExecutable(
  item: AfterSalesCase,
  order: Order,
  receipt?: Refund | null,
) {
  const review = approvalFor(item);
  if (
    !review ||
    review.decision !== "approve" ||
    !["approved", "executing", "unknown", "completed"].includes(item.status)
  )
    throw new ForbiddenException("当前版本没有有效审批，不能执行退款");
  if (receipt) {
    if (
      receipt.caseId !== item.id ||
      receipt.version !== item.version ||
      receipt.amountCents !== item.amountCents ||
      receipt.orderId !== item.orderId
    )
      throw new ConflictException("业务回执与当前申请不一致，请人工核对");
  } else if (item.status !== "completed") assertAmount(item.amountCents, order);
}
export function requestKey(item: Pick<AfterSalesCase, "id" | "version">) {
  return `refund:${item.id}:v${item.version}`;
}
export function canEdit(item: AfterSalesCase) {
  if (!["waiting_review", "needs_materials"].includes(item.status))
    throw new ConflictException("当前申请已进入执行或终态，不能修改");
}

export const caseStatuses: CaseStatus[] = [
  "waiting_review",
  "needs_materials",
  "approved",
  "executing",
  "unknown",
  "completed",
  "rejected",
  "cancelled",
];

export function assertReviewNote(decision: Review["decision"], note: string) {
  if (decision !== "approve" && note.trim().length < 3)
    throw new BadRequestException("退回补充或拒绝时，请填写至少 3 个字的具体原因");
}

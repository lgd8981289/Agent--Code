import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import type {
  Actor,
  AfterSalesCase,
  Investigation,
  Order,
  Refund,
  Review,
} from "../shared/types.js";
import {
  assertAmount,
  assertCustomer,
  assertExecutable,
  assertOwner,
  assertReviewer,
  assertReviewNote,
  assertVersion,
  canEdit,
} from "./domain.js";

/** 申请版本、审核和依赖产物的规则，所有入口共用。持久化与工具调用留在用例层。 */
export class AfterSalesAggregate {
  constructor(readonly value: AfterSalesCase) {}
  private changed() {
    this.value.updatedAt = new Date().toISOString();
  }
  private invalidateInvestigation(reason: string) {
    if (this.value.investigation) {
      this.value.investigation = {
        ...this.value.investigation,
        status: "stale",
        staleReason: reason,
      };
    }
  }

  /** 修改售后申请：校验客户权限、申请版本和退款金额，更新申请内容并重新进入审核状态。 */
  revise(
    actor: Actor,
    version: number,
    order: Order,
    amountCents: number,
    reason: string,
    materialIds: string[],
  ) {
    // 确认当前用户具有客户权限，并且是这笔申请的所有者。
    assertCustomer(actor);
    assertOwner(actor, this.value);

    // 检查当前申请是否允许修改，避免修改已结束或不可编辑的申请。
    canEdit(this.value);

    // 校验申请版本，防止客户使用过期的申请数据覆盖最新内容。
    assertVersion(this.value, version);

    // 根据订单数据校验本次申请的退款金额，确保金额符合业务限制。
    assertAmount(amountCents, order);

    // 申请内容发生变化，递增版本号，使旧版本的审核结果无法直接用于新版本。
    this.value.version++;

    // 更新退款金额、申请原因和材料列表，并将申请重新设为待审核状态。
    Object.assign(this.value, {
      amountCents,
      reason,
      materialIds,
      status: "waiting_review",
    });

    // 申请内容已发生变化，原有调查结果不再作为当前版本的有效依据。
    // 要求后续流程针对修改后的申请重新调查。
    this.invalidateInvestigation("申请内容已经修改，请对当前版本重新调查");

    // 标记申请发生变更，执行聚合内部统一的状态更新逻辑。
    this.changed();
  }

  changeMaterial(actor: Actor, version: number, id: string, remove: boolean) {
    assertCustomer(actor);
    assertOwner(actor, this.value);
    canEdit(this.value);
    assertVersion(this.value, version);
    this.value.materialIds = remove
      ? this.value.materialIds.filter((v) => v !== id)
      : [...new Set([...this.value.materialIds, id])];
    this.value.version++;
    this.value.status = "needs_materials";
    this.invalidateInvestigation("材料已经修改，请对当前版本重新调查");
    this.changed();
  }

  /** 执行售后申请审核：校验审核权限、申请版本和当前状态，记录审核决定并更新申请状态。 */
  review(
    actor: Actor,
    input: { version: number; decision: Review["decision"]; note: string },
  ) {
    // 校验当前用户是否具有审核权限，以及是否有权操作这笔申请。
    assertReviewer(actor);
    assertOwner(actor, this.value, true);

    // 校验申请版本，防止审核人员基于过期的申请信息作出决定。
    assertVersion(this.value, input.version);

    // 检查审核意见是否符合当前审核决定的要求。
    assertReviewNote(input.decision, input.note);

    // 只有处于待审核状态的申请才能进行审核，避免重复审核或非法状态变更。
    if (this.value.status !== "waiting_review")
      throw new ConflictException("这份申请当前不在待审核状态");

    // 将本次审核决定追加到审核历史中，保留审核人员、意见和时间。
    this.value.reviews.push({
      id: randomUUID(),
      ...input,
      note: input.note.trim(), // 去除审核意见首尾的空白字符。
      reviewerId: actor.id, // 记录当前审核人员 ID。
      at: new Date().toISOString(), // 记录审核时间。
    });

    // 根据审核决定更新申请状态：
    // approve：审核通过，进入已批准状态。
    // revise：退回补充，等待客户完善申请材料。
    // reject：审核拒绝，申请进入已拒绝状态。
    this.value.status = (
      {
        approve: "approved",
        revise: "needs_materials",
        reject: "rejected",
      } as const
    )[input.decision];

    // 标记申请发生变更，执行聚合内部统一的状态更新逻辑。
    this.changed();
  }

  cancel(actor: Actor, version: number, reason: string) {
    assertCustomer(actor);
    assertOwner(actor, this.value);
    assertVersion(this.value, version);
    if (this.value.status === "cancelled") return false;
    canEdit(this.value);
    this.value.status = "cancelled";
    this.changed();
    this.value.cancelledAt = this.value.updatedAt;
    this.value.cancellationReason = reason.trim();
    return true;
  }
  attachInvestigation(report: Investigation) {
    if (report.caseVersion !== this.value.version)
      throw new ConflictException("调查对应旧版本，请重新调查当前申请");
    this.value.investigation = report;
    this.changed();
  }
  complete(order: Order, receipt: Refund) {
    assertExecutable(this.value, order, receipt);
    this.value.refund = receipt;
    this.value.status = "completed";
    this.value.lastError = null;
    this.changed();
  }
}

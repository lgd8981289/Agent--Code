import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import type { Actor, AfterSalesCase, Order, Refund } from "../shared/types.js";
import { assertCustomer, assertExecutable, assertOwner, requestKey } from "./domain.js";
import type { Storage } from "./storage.js";

/** MCP 服务也检查业务权限；宿主漏掉检查时，业务服务仍然拒绝执行。 */
export class Business {
  constructor(readonly db: Storage) {}
  async order(actor: Actor, id: string) {
    const order = await this.db.get<Order>("order", id);
    if (!order) throw new NotFoundException("订单不存在");
    assertOwner(actor, order);
    return order;
  }
  async orders(actor: Actor) {
    assertCustomer(actor);
    return this.db.list<Order>("order", actor.tenantId, actor.id);
  }
  /** 根据售后申请查询退款回执，校验申请归属，未找到回执时返回 null。 */
  async lookup(actor: Actor, caseId: string) {
    // 根据申请 ID 查询售后申请记录。
    const item = await this.db.get<AfterSalesCase>("case", caseId);

    // 申请不存在时，抛出 404 异常。
    if (!item) throw new NotFoundException("申请不存在");

    // 校验当前用户是否有权访问这笔申请，防止越权查询退款信息。
    assertOwner(actor, item);

    // 根据申请生成稳定的退款请求键，从退款记录表中查询已有回执。
    // 使用参数化 SQL，避免直接拼接查询参数。
    const row = await this.db.pool.query(
      "SELECT data FROM af_refunds WHERE request_key=$1",
      [requestKey(item)],
    );

    // 如果找到退款记录，则返回保存的回执数据。
    // 如果没有记录，则返回 null，表示当前未查询到对应退款回执。
    return (row.rows[0]?.data ?? null) as Refund | null;
  }

  /** 执行退款：校验审批与订单状态，通过请求键防止重复退款，并模拟提交前及提交后的故障。 */
  async refund(actor: Actor, caseId: string): Promise<Refund> {
    // 确认当前用户具有客户权限。
    assertCustomer(actor);

    // 标记是否需要模拟“业务提交成功，但响应丢失”的故障。
    let failAfterCommit = false;

    // 使用数据库事务执行退款，保证回执写入和订单退款金额更新的一致性。
    const result = await this.db.transaction(async (client) => {
      // 在事务中读取并锁定申请记录，避免并发修改。
      const item = await this.db.get<AfterSalesCase>("case", caseId, client, true);
      if (!item) throw new NotFoundException("申请不存在");
      assertOwner(actor, item);

      // 读取并锁定对应订单，确保退款金额校验与更新基于当前订单状态。
      const order = await this.db.get<Order>("order", item.orderId, client, true);
      if (!order) throw new NotFoundException("订单不存在");
      assertOwner(actor, order);

      // 根据申请生成稳定的退款请求键，用于识别同一次退款操作。
      const key = requestKey(item);

      // 先查询是否存在相同请求键的退款回执。
      const existing = await client.query(
        "SELECT data FROM af_refunds WHERE request_key=$1",
        [key],
      );

      // 先核对审批，再返回既有回执；不能让幂等查询变成绕过审批的入口。
      assertExecutable(item, order, existing.rows[0]?.data);

      // 如果已有对应回执，则直接返回，不重复创建退款记录或扣减可退金额。
      if (existing.rows.length) return existing.rows[0].data as Refund;

      // 模拟退款提交前服务不可用，此时尚未创建退款回执。
      if (item.fault === "before_submit" && !item.faultConsumed)
        throw new Error("演示故障：提交前业务服务暂不可用");

      // 创建新的退款回执，记录申请、订单、版本和退款金额。
      const receipt: Refund = {
        id: `RF-${randomUUID().slice(0, 8).toUpperCase()}`,
        requestKey: key,
        caseId,
        version: item.version,
        orderId: item.orderId,
        amountCents: item.amountCents,
        status: "completed",
        at: new Date().toISOString(),
      };

      // 将退款回执写入数据库，request_key 用于后续幂等查询。
      await client.query(
        "INSERT INTO af_refunds(request_key,case_id,data) VALUES($1,$2,$3)",
        [key, caseId, JSON.stringify(receipt)],
      );

      // 更新订单累计已退款金额，与回执写入处于同一个事务中。
      order.refundedCents += item.amountCents;
      await this.db.put("order", order, client);

      // 判断是否需要模拟“退款已提交成功，但响应返回前超时”的故障。
      failAfterCommit = item.fault === "timeout_after_commit" && !item.faultConsumed;

      if (failAfterCommit) {
        // 标记该演示故障已触发，避免后续重复注入相同故障。
        item.faultConsumed = true;
        await this.db.put("case", item, client);
      }

      // 返回本次创建的退款回执。
      return receipt;
    });

    // 故意在事务提交完成后抛出异常，模拟业务成功但调用方没有收到响应。
    // 此时退款回执和订单金额已经保存，后续应通过原请求键查询结果。
    if (failAfterCommit)
      throw new Error("演示故障：业务已受理，但响应在返回前丢失；请查询原请求结果");

    // 正常情况下，返回新创建或此前已存在的退款回执。
    return result;
  }
}

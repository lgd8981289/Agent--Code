import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Actor, AfterSalesCase, Material } from "../shared/types.js";
import { assertOwner } from "./domain.js";
import { Storage } from "./storage.js";

/** 当前材料查询只有一个入口；历史审计仍按 material ID 读取原记录。 */
@Injectable()
export class MaterialRepository {
  constructor(@Inject(Storage) readonly db: Storage) {}
  async active(actor: Actor, conversationId: string, orderId?: string) {
    const result = await this.db.pool.query(
      `SELECT data FROM af_records WHERE kind='material' AND tenant_id=$1 AND user_id=$2
       AND data->>'conversationId'=$3 AND data->>'removedAt' IS NULL ORDER BY data->>'at', id`,
      [actor.tenantId, actor.id, conversationId],
    );
    return result.rows
      .map((r) => r.data as Material)
      .filter((m) => !orderId || !m.orderId || m.orderId === orderId);
  }
}

@Injectable()
export class CaseRepository {
  constructor(@Inject(Storage) readonly db: Storage) {}
  async get(actor: Actor, id: string) {
    const item = await this.db.get<AfterSalesCase>("case", id);
    if (!item) throw new NotFoundException("申请不存在");
    assertOwner(actor, item, true);
    return item;
  }
  async forCustomer(actor: Actor) {
    const result = await this.db.pool.query(
      `SELECT data FROM af_records WHERE kind='case' AND tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC, id`,
      [actor.tenantId, actor.id],
    );
    return result.rows.map((r) => r.data as AfterSalesCase);
  }
}

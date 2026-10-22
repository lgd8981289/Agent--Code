import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Storage } from "./storage.js";
import type { Actor, Trace } from "../shared/types.js";

export type TraceScope = {
  actor: Actor;
  conversationId?: string;
  caseId?: string;
  parentId?: string;
};
@Injectable()
export class Traces {
  private readonly logger = new Logger(Traces.name);
  constructor(@Inject(Storage) readonly db: Storage) {}
  async run<T>(
    scope: TraceScope,
    kind: string,
    name: string,
    input: unknown,
    fn: (id: string) => Promise<T>,
  ): Promise<T> {
    const id = randomUUID(),
      start = performance.now();
    let output: unknown,
      status: Trace["status"] = "completed";
    try {
      const result = await fn(id);
      output = result;
      return result;
    } catch (e) {
      status = "failed";
      output = { error: (e as Error).message };
      throw e;
    } finally {
      try {
        await this.db.put("trace", {
          id,
          tenantId: scope.actor.tenantId,
          userId: scope.actor.id,
          conversationId: scope.conversationId || null,
          caseId: scope.caseId || null,
          parentId: scope.parentId || null,
          kind,
          name,
          input,
          output,
          status,
          durationMs: Math.round(performance.now() - start),
          at: new Date().toISOString(),
        } satisfies Trace);
      } catch (error) {
        // Trace 是诊断记录；申请历史、审批和回执仍由业务事务负责。
        this.logger.warn({
          message: "Trace 保存失败",
          traceId: id,
          kind,
          name,
          error: String(error),
        });
      }
    }
  }
}

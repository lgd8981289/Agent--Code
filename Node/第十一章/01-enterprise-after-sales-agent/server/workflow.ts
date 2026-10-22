import {
  Inject,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { Storage } from "./storage.js";
import { McpBridge } from "./mcp.js";
import { Traces } from "./trace.js";
import { accounts } from "./fixtures.js";
import { approvalFor, assertExecutable } from "./domain.js";
import { AfterSalesAggregate } from "./case.aggregate.js";
import type { AfterSalesCase } from "../shared/types.js";

const Flow = Annotation.Root({
  caseId: Annotation<string>(),
  route: Annotation<string>(),
});
@Injectable()
export class RefundWorkflow implements OnModuleInit {
  private graph!: ReturnType<RefundWorkflow["build"]>;
  constructor(
    @Inject(Storage) readonly db: Storage,
    @Inject(McpBridge) readonly mcp: McpBridge,
    @Inject(Traces) readonly trace: Traces,
  ) {}
  private async item(id: string) {
    const item = await this.db.get<AfterSalesCase>("case", id);
    if (!item) throw new NotFoundException("申请不存在");
    return item;
  }

  /** 生成售后审批工作流的运行配置，指定线程 ID 和最大执行步数。 */
  private config(id: string) {
    return {
      // 为每笔售后申请生成固定的 LangGraph 线程 ID。
      // 同一申请使用相同 thread_id，便于关联检查点并恢复工作流状态。
      configurable: { thread_id: `refund-flow:${id}` },

      // 限制状态图的最大递归执行步数，防止工作流陷入无限循环。
      recursionLimit: 30,
    };
  }

  /** 构建售后审批工作流：通过 LangGraph 编排人工审核、材料补充、退款执行和失败恢复。 */
  private build() {
    return (
      new StateGraph(Flow)
        // 人工审核节点：等待审批结果，并根据最新申请状态决定后续流程。
        .addNode("review", async (state) => {
          // 获取当前申请；如果已撤回，则直接进入取消分支。
          const item = await this.item(state.caseId);
          if (item.status === "cancelled") return { route: "cancel" };

          // 暂停工作流，等待外部人工审核。
          // interrupt 会保存中断状态，恢复执行时接收外部传入的版本信息。
          const answer = interrupt({
            type: "approval",
            caseId: item.id,
            version: item.version,
          }) as { version: number };

          // 恢复后重新查询申请，避免使用中断前的旧数据。
          const current = await this.item(state.caseId);
          if (current.status === "cancelled") return { route: "cancel" };

          // 获取当前版本对应的审批记录。
          const review = approvalFor(current);

          // 如果恢复时的版本与最新申请版本不一致，或缺少有效审批记录，
          // 则返回审核节点，重新等待人工确认。
          if (answer.version !== current.version || !review) return { route: "again" };

          // 根据审批决定，进入通过、补充材料或拒绝分支。
          return { route: review.decision };
        })

        // 材料补充节点：暂停工作流，等待客户补充或修改申请材料。
        .addNode("supplement", async (state) => {
          // 如果申请已撤回，则不再等待补充材料。
          if ((await this.item(state.caseId)).status === "cancelled")
            return { route: "cancel" };

          // 中断当前工作流，等待外部完成材料补充并恢复执行。
          interrupt({ type: "materials", caseId: state.caseId });

          // 恢复后再次检查申请状态。
          // 未撤回则返回人工审核节点，让企业重新审核。
          return {
            route:
              (await this.item(state.caseId)).status === "cancelled"
                ? "cancel"
                : "review",
          };
        })

        // 退款执行节点：调用实际业务逻辑，根据执行结果决定结束或重试。
        .addNode("execute", async (state) => {
          // 执行当前申请对应的退款处理。
          const result = await this.execute(state.caseId);

          // 退款完成则结束流程，否则进入异常核对与恢复节点。
          return { route: result.status === "completed" ? "done" : "retry" };
        })

        // 异常恢复节点：暂停工作流，等待外部核对退款执行结果。
        .addNode("retry", async (state) => {
          // 请求外部进行退款结果核对，避免执行状态不明时直接重复操作。
          interrupt({ type: "reconcile", caseId: state.caseId });

          // 恢复后返回空状态更新，后续通过固定边重新进入执行节点。
          return {};
        })

        // 设置工作流入口：从人工审核节点开始。
        .addEdge(START, "review")

        // 根据人工审核结果选择后续节点。
        .addConditionalEdges("review", (state) => state.route, {
          approve: "execute", // 审核通过：执行退款。
          revise: "supplement", // 需要修改：等待客户补充材料。
          reject: END, // 审核拒绝：结束流程。
          cancel: END, // 客户撤回：结束流程。
          again: "review", // 版本变化或审批无效：重新审核。
        })

        // 材料补充完成后重新审核；申请撤回则直接结束。
        .addConditionalEdges("supplement", (state) => state.route, {
          cancel: END,
          review: "review",
        })

        // 根据退款执行结果，决定结束工作流或进入异常恢复节点。
        .addConditionalEdges("execute", (state) => state.route, {
          done: END, // 退款完成，结束工作流。
          retry: "retry", // 未完成，等待人工核对执行结果。
        })

        // 异常核对完成并恢复工作流后，再次进入退款执行节点。
        .addEdge("retry", "execute")

        // 编译状态图，并配置 Checkpointer 保存工作流状态。
        // 配合固定的 thread_id，可以在人工审核等中断节点恢复执行。
        .compile({ checkpointer: this.db.saver })
    );
  }

  async onModuleInit() {
    this.graph = this.build();
    const rows = await this.db.pool.query(
      "SELECT data FROM af_records WHERE kind='case' AND data->>'status' IN ('approved','executing','cancelled')",
    );
    for (const row of rows.rows) {
      setImmediate(
        () =>
          void this.db
            .locked(`case:${row.data.id}`, () =>
              row.data.status === "cancelled"
                ? this.cancel(row.data.id)
                : this.continue(row.data.id),
            )
            .catch((e) => console.error("恢复任务失败：", e.message)),
      );
    }
  }

  /** 启动指定售后申请的工作流，通过 LangGraph 执行状态图。 */
  async start(id: string) {
    // 以申请 ID 作为工作流输入，并传入该申请对应的运行配置。
    // invoke 会执行状态图，并等待本次调用完成后返回。
    await this.graph.invoke({ caseId: id }, this.config(id));
  }

  /** 恢复售后审核工作流：检查当前执行状态，并携带最新申请版本继续执行 LangGraph。 */
  async decision(id: string) {
    // 根据申请对应的 thread_id，读取 LangGraph 保存的工作流状态。
    let current = await this.graph.getState(this.config(id));

    // 如果工作流下一步仍是材料补充节点，则先尝试推进该节点。
    // 覆盖“新版本已保存、补充材料节点尚未恢复”时进程退出的窗口。
    if (current.next.includes("supplement")) {
      await this.supplemented(id);

      // 补充材料流程推进后，重新获取最新工作流状态。
      current = await this.graph.getState(this.config(id));
    }

    // 如果当前检查点中没有申请 ID，则尝试初始化对应的审批工作流。
    if (!current.values?.caseId) await this.start(id);

    // 通过 Command.resume 恢复处于 interrupt 中断状态的工作流。
    // 使用数据库中的最新申请版本，让审核节点校验恢复时的版本是否一致。
    await this.graph.invoke(
      new Command({ resume: { version: (await this.item(id)).version } }),
      this.config(id),
    );
  }

  /** 恢复材料补充工作流：如果当前停留在补充材料节点，则通知 LangGraph 继续执行。 */
  async supplemented(id: string) {
    // 根据申请 ID 对应的 thread_id，读取 LangGraph 保存的工作流状态。
    const state = await this.graph.getState(this.config(id));

    // 只有工作流下一步仍是 supplement 节点时，才尝试恢复执行。
    if (state.next.includes("supplement"))
      // 通过 Command.resume 向中断节点传入 true，恢复材料补充流程。
      // 恢复后，supplement 节点会重新检查申请状态，
      // 未撤回的申请将重新进入人工审核节点。
      await this.graph.invoke(new Command({ resume: true }), this.config(id));
  }

  async continue(id: string) {
    const state = await this.graph.getState(this.config(id));
    if (!state.values?.caseId || state.next.includes("review"))
      return this.decision(id);
    if (state.next.includes("retry"))
      await this.graph.invoke(new Command({ resume: true }), this.config(id));
    else if (state.next.length) await this.graph.invoke(null, this.config(id));
  }
  async retry(id: string) {
    await this.continue(id);
  }
  async cancel(id: string) {
    const state = await this.graph.getState(this.config(id));
    if (state.next.includes("review") || state.next.includes("supplement"))
      await this.graph.invoke(
        new Command({ resume: { version: (await this.item(id)).version } }),
        this.config(id),
      );
  }

  /** 执行或恢复退款：校验审批状态、核对已有退款回执，必要时提交退款并记录执行结果。 */
  async execute(id: string) {
    // 获取当前售后申请，如果已经完成退款，则直接返回，避免重复执行。
    let item = await this.item(id);
    if (item.status === "completed") return item;

    // 只有处于已批准、执行中或结果待确认状态，
    // 且当前存在有效的通过审批记录时，才允许执行退款。
    if (
      !["approved", "executing", "unknown"].includes(item.status) ||
      approvalFor(item)?.decision !== "approve"
    )
      throw new ForbiddenException("当前申请没有可执行的审批");

    // 根据申请所属用户和租户找到对应身份，后续以该客户身份调用 MCP 业务工具。
    const actor = accounts.find(
      (a) => a.id === item.userId && a.tenantId === item.tenantId,
    )!;

    // 构建 Trace 上下文，将本次执行关联到用户、会话和售后申请。
    const scope = { actor, conversationId: item.conversationId, caseId: id };

    // 记录本次退款执行过程，方便追踪订单查询、回执核对和退款提交。
    return this.trace.run(
      scope,
      "workflow",
      "执行或核对退款",
      { caseId: id, version: item.version },
      async (parentId) => {
        // 将申请标记为执行中，增加执行尝试次数，并保存最新状态。
        item.status = "executing";
        item.attempts++;
        item.updatedAt = new Date().toISOString();
        await this.db.put("case", item);

        try {
          // 重新查询订单，确保后续退款校验使用最新的业务数据。
          const order = await this.mcp.call(actor, "get_order", {
            orderId: item.orderId,
          });

          // 先根据申请 ID 查询已有退款回执，判断此前是否已经提交过退款。
          // 将 MCP 调用关联到当前 Trace，便于检查工具输入和返回结果。
          let receipt = await this.trace.run(
            { ...scope, parentId },
            "mcp",
            "get_refund",
            { caseId: id },
            () => this.mcp.call(actor, "get_refund", { caseId: id }),
          );

          // 校验当前申请、订单及已有回执是否满足退款执行要求。
          assertExecutable(item, order, receipt);

          // 先查回执：覆盖“外部已提交，但本地尚未写入完成状态”的恢复窗口。
          // 只有不存在已有退款回执时，才调用工具提交退款。
          if (!receipt)
            receipt = await this.trace.run(
              { ...scope, parentId },
              "mcp",
              "submit_refund",
              { caseId: id },
              () => this.mcp.call(actor, "submit_refund", { caseId: id }),
            );

          // 重新读取申请，并通过领域聚合根据订单和回执完成退款状态更新。
          item = await this.item(id);
          new AfterSalesAggregate(item).complete(order, receipt);
        } catch (e) {
          // 订单核验、回执查询或退款执行出现异常时，
          // 不直接认定退款失败，而是标记为结果待确认，等待后续核对。
          item = await this.item(id);
          item.status = "unknown";
          item.lastError = (e as Error).message;
        }

        // 保存本次执行后的最终申请状态和更新时间。
        item.updatedAt = new Date().toISOString();
        await this.db.put("case", item);

        // 记录退款状态事件，供后续查询和追踪执行结果。
        await this.db.put("event", {
          id: randomUUID(),
          tenantId: actor.tenantId,
          userId: actor.id,
          caseId: id,
          at: item.updatedAt,
          status: item.status,
        });

        // 返回最新申请状态，供 LangGraph 判断结束流程还是进入异常恢复节点。
        return item;
      },
    );
  }
}

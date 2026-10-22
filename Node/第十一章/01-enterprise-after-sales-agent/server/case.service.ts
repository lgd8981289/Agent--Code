import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  Actor,
  AfterSalesCase,
  Conversation,
  Material,
  Mode,
  Order,
  Trace,
} from "../shared/types.js";
import { Storage } from "./storage.js";
import { McpBridge } from "./mcp.js";
import { Knowledge } from "./knowledge.service.js";
import { RefundWorkflow } from "./workflow.js";
import { Traces } from "./trace.js";
import { Investigator } from "./investigation.service.js";
import { MaterialRepository, CaseRepository } from "./repositories.js";
import { AfterSalesAggregate } from "./case.aggregate.js";
import {
  assertAmount,
  assertCustomer,
  assertOwner,
  assertReviewer,
  assertVersion,
  assertReviewNote,
  canEdit,
} from "./domain.js";

@Injectable()
export class CaseService {
  constructor(
    @Inject(Storage) readonly db: Storage,
    @Inject(McpBridge) readonly mcp: McpBridge,
    @Inject(Knowledge) readonly knowledge: Knowledge,
    @Inject(RefundWorkflow) readonly workflow: RefundWorkflow,
    @Inject(Traces) readonly trace: Traces,
    @Inject(Investigator) readonly investigator: Investigator,
    @Inject(MaterialRepository) readonly materialRepository: MaterialRepository,
    @Inject(CaseRepository) readonly caseRepository: CaseRepository,
  ) {}
  async conversation(actor: Actor, id: string) {
    const c = await this.db.get<Conversation>("conversation", id);
    if (!c) throw new NotFoundException("会话不存在");
    assertOwner(actor, c);
    return c;
  }
  async materialList(actor: Actor, id: string) {
    const c = await this.conversation(actor, id);
    const orderId = c.caseId
      ? (await this.getCase(actor, c.caseId)).orderId
      : c.proposal?.order.id;
    return this.materialRepository.active(actor, id, orderId);
  }
  async history(item: AfterSalesCase, actor: Actor, action: string, note: string) {
    const materials = await Promise.all(
      item.materialIds.map((id) => this.db.get<Material>("material", id)),
    );
    (item.history ??= []).push({
      id: randomUUID(),
      at: item.updatedAt,
      actorId: actor.id,
      actorName: actor.name,
      action,
      note,
      version: item.version,
      status: item.status,
      amountCents: item.amountCents,
      reason: item.reason,
      materials: materials
        .filter((m): m is Material => !!m)
        .map((m) => ({
          id: m.id,
          name: m.name,
          observation: m.observation,
        })),
    });
  }
  async getCase(actor: Actor, id: string) {
    return this.caseRepository.get(actor, id);
  }
  async confirmedMaterials(actor: Actor, c: Conversation) {
    const materials = await this.materialList(actor, c.id);
    if (!materials.some((m) => m.kind === "image" && m.confirmed))
      throw new BadRequestException("请先上传损坏照片并确认材料说明");
    return materials.filter((m) => m.confirmed).map((m) => m.id);
  }

  /** 提交售后申请：校验草稿版本、政策依据、订单金额和材料，创建申请并启动审批流程。 */
  async submit(
    actor: Actor,
    conversationId: string,
    input: {
      orderId: string;
      draftVersion: number;
      amountCents: number;
      reason: string;
      fault: AfterSalesCase["fault"];
    },
  ) {
    // 确认当前用户具有客户权限。
    assertCustomer(actor);

    // 对当前会话加锁，避免同一会话并发提交申请。
    return this.db.locked(`conversation:${conversationId}`, async () => {
      // 获取会话并校验访问权限。
      const c = await this.conversation(actor, conversationId);

      // 如果会话已经关联正式申请，则直接返回已有申请，避免重复创建。
      if (c.caseId) return this.getCase(actor, c.caseId);

      // 核对订单 ID 和草稿版本号，确保客户提交的是当前最新的处理建议。
      // 如果 Agent 更新了建议或用户修改了材料，旧版本草稿不能继续提交。
      if (
        input.orderId !== c.proposal?.order.id ||
        input.draftVersion !== (c.draftVersion ?? 0)
      )
        throw new ConflictException("处理建议或材料已经变化，请刷新后重新确认当前草稿");

      // 检查草稿是否满足基础申请资格，并且已引用至少三条政策依据。
      if (!c.proposal?.eligible || c.proposal.sourceIds.length < 3)
        throw new BadRequestException("请先完成订单与三类政策依据的核对");

      // 重新核验政策资料，防止提交时仍使用已失效或不适用的政策。
      const evidence = this.knowledge.revalidate(actor.tenantId, c.evidence ?? []);

      // 必须具备适用条件、材料要求和审批规则三类有效政策依据。
      if (new Set(evidence.map((p) => p.category)).size !== 3)
        throw new BadRequestException("政策依据已经变化，请重新查询当前政策再提交");

      // 通过 MCP 重新查询订单，不能直接相信草稿中缓存的订单金额。
      const order = await this.mcp.call(actor, "get_order", {
        orderId: c.proposal.order.id,
      });

      // 根据最新订单数据校验客户提交的退款金额，金额单位为分。
      // 例如：页面提交 3500 元，对应 amountCents = 350000。
      assertAmount(input.amountCents, order);

      // 检查订单签收时间，超过本演示政策的 7 天期限则不允许直接提交。
      if (Date.now() - new Date(order.signedAt).getTime() > 7 * 86400000)
        throw new BadRequestException("已超过本演示政策的申请时间范围，请人工核对");

      // 获取当前会话中已确认、可用于本次申请的材料 ID。
      const materialIds = await this.confirmedMaterials(actor, c);

      // 生成申请创建时间和唯一 ID。
      const now = new Date().toISOString(),
        id = randomUUID();

      // 创建正式售后申请，初始状态为等待企业审核。
      const item: AfterSalesCase = {
        id,
        number: `AS-${id.slice(0, 8).toUpperCase()}`, // 生成便于展示的申请编号。
        tenantId: actor.tenantId,
        userId: actor.id,
        conversationId: c.id, // 关联原始售后沟通会话。
        orderId: order.id,
        product: order.product,
        paidCents: order.paidCents, // 最新订单实付金额，单位为分。
        amountCents: input.amountCents, // 客户确认的申请退款金额，单位为分。
        reason: input.reason, // 客户填写的售后申请原因。
        version: 1, // 正式申请的初始版本号。
        status: "waiting_review", // 初始状态：等待企业审核。
        materialIds, // 本次申请关联的已确认材料。
        sourceIds: evidence.map((p) => p.id), // 引用的有效政策 ID。
        policySnapshots: evidence, // 保存提交时的政策快照，供后续审核和追溯。
        reviews: [], // 初始化为空审批记录。
        refund: null, // 尚未执行退款。
        lastError: null,
        attempts: 0, // 初始化执行尝试次数。
        fault: input.fault,
        faultConsumed: false,
        investigation: null,
        createdAt: now,
        updatedAt: now,
      };

      // 记录客户提交申请的操作历史。
      await this.history(item, actor, "提交申请", "客户核对金额、说明与材料后提交");

      // 使用数据库事务保存正式申请，并将原会话关联到该申请。
      await this.db.transaction(async (client) => {
        // 在事务内重新读取最新订单数据，并执行金额校验。
        // 避免使用事务开始前查询到的过期订单金额。
        const latestOrder = await this.db.get<Order>("order", order.id, client, true);
        if (!latestOrder) throw new NotFoundException("订单不存在");
        assertAmount(input.amountCents, latestOrder);

        // 查询同一租户、同一订单是否存在尚未结束的售后申请。
        // 已完成、已拒绝或已撤回的申请不计入正在处理的申请。
        const active = await client.query(
          "SELECT id FROM af_records WHERE kind='case' AND tenant_id=$1 AND data->>'orderId'=$2 AND data->>'status' NOT IN ('completed','rejected','cancelled')",
          [actor.tenantId, order.id],
        );

        // 如果订单已有正在处理的申请，则禁止重复提交。
        if (active.rows.length)
          throw new ConflictException(
            "这个订单已有正在处理的申请，请到申请列表继续跟进",
          );

        // 保存新申请，并将申请 ID 写入原会话。
        // 两项数据库写入在同一事务中完成。
        await this.db.put("case", item, client);
        c.caseId = id;
        await this.db.put("conversation", c, client);
      });

      // 正式申请保存成功后，启动后续售后审批工作流。
      // 通过 Trace 记录工作流启动过程，方便追踪执行状态。
      await this.trace.run(
        { actor, conversationId, caseId: id },
        "workflow",
        "客户确认申请",
        { amountCents: item.amountCents, version: 1 },
        async () => {
          await this.workflow.start(id);
          return { status: "waiting_review" };
        },
      );

      // 返回创建完成的正式售后申请。
      return item;
    });
  }

  /** 重新提交售后申请：校验申请版本与退款金额，更新材料及申请内容，并恢复审核工作流。 */
  async revise(
    actor: Actor,
    id: string,
    input: { version: number; amountCents: number; reason: string },
  ) {
    // 确认当前用户具有客户权限。
    assertCustomer(actor);

    // 对当前申请加锁，避免并发修改导致申请状态或版本冲突。
    return this.db.locked(`case:${id}`, async () => {
      // 获取当前申请，并检查是否允许编辑及版本是否匹配。
      const item = await this.getCase(actor, id);
      canEdit(item);
      assertVersion(item, input.version);

      // 通过 MCP 重新查询订单，确保使用最新订单数据校验退款金额。
      const order = await this.mcp.call(actor, "get_order", {
        orderId: item.orderId,
      });
      assertAmount(input.amountCents, order);

      // 获取原会话中已确认的材料，并更新本次申请关联的材料列表。
      item.materialIds = await this.confirmedMaterials(
        actor,
        await this.conversation(actor, item.conversationId),
      );

      // 通过领域聚合修改申请内容。
      // 内部会再次校验业务规则、递增申请版本，并将状态改为待审核。
      new AfterSalesAggregate(item).revise(
        actor,
        input.version,
        order,
        input.amountCents,
        input.reason,
        item.materialIds,
      );

      // 记录客户重新确认申请的操作历史。
      await this.history(item, actor, "重新确认申请", "当前版本重新提交企业审核");

      // 持久化更新后的申请，包括新版本、退款金额、原因和材料等信息。
      await this.db.put("case", item);

      // 通知 LangGraph 材料补充已完成，恢复对应的审批工作流。
      // 后续流程会重新进入人工审核，而不是直接执行退款。
      await this.workflow.supplemented(id);

      // 返回修改后的售后申请。
      return item;
    });
  }

  /** 企业审核售后申请：校验审核权限与版本，保存审核决定，并推动审批工作流继续执行。 */
  async review(
    actor: Actor,
    id: string,
    input: {
      version: number;
      decision: "approve" | "revise" | "reject";
      note: string;
    },
  ) {
    // 确认当前用户具有企业审核权限，并校验审核意见是否符合要求。
    assertReviewer(actor);
    assertReviewNote(input.decision, input.note);

    // 对当前申请加锁，避免多个审核人员同时修改同一笔申请。
    return this.db.locked(`case:${id}`, async () => {
      // 获取当前售后申请，并校验访问权限。
      const item = await this.getCase(actor, id);

      // 通过领域聚合执行审核操作。
      // 根据审核决定和版本号，校验并更新申请的业务状态。
      new AfterSalesAggregate(item).review(actor, input);

      // 记录本次审核操作，包括审核结果和审核人员填写的意见。
      await this.history(
        item,
        actor,
        { approve: "批准申请", revise: "退回补充", reject: "拒绝申请" }[input.decision],
        input.note.trim(),
      );

      // 先持久化审核结果，确保后续工作流能够读取到最新的审批状态。
      await this.db.put("case", item);

      // 通过 Trace 记录本次企业审核，并通知工作流处理最新审核决定。
      await this.trace.run(
        { actor, caseId: id, conversationId: item.conversationId },
        "approval",
        "企业审核当前申请",
        input,
        async () => {
          // 根据已保存的审核决定，推动对应的 LangGraph 工作流继续执行。
          // 后续可能进入退款执行、材料补充或结束流程。
          await this.workflow.decision(id);

          // 返回工作流处理后的最新申请状态，作为本次追踪结果。
          return this.getCase(actor, id);
        },
      );

      // 重新查询申请，返回经过审核和工作流处理后的最新状态。
      return this.getCase(actor, id);
    });
  }

  async cancel(actor: Actor, id: string, version: number, reason: string) {
    assertCustomer(actor);
    if (reason.trim().length < 3 || reason.length > 500)
      throw new BadRequestException("请填写 3 到 500 字的撤回原因");
    return this.db.locked(`case:${id}`, async () => {
      const item = await this.getCase(actor, id);
      if (!new AfterSalesAggregate(item).cancel(actor, version, reason)) return item;
      await this.history(item, actor, "客户撤回", item.cancellationReason!);
      await this.db.put("case", item);
      await this.workflow.cancel(id);
      return item;
    });
  }

  /** 重试退款执行：校验申请状态和重试次数，清除指定演示故障，并恢复退款工作流。 */
  async retry(actor: Actor, id: string) {
    // 对当前申请加锁，避免多个重试请求同时修改申请状态。
    return this.db.locked(`case:${id}`, async () => {
      // 获取当前售后申请，并校验访问权限。
      const item = await this.getCase(actor, id);

      // 如果退款已经完成，则直接返回，避免重复执行。
      if (item.status === "completed") return item;

      // 只有结果待确认、已批准或执行中的申请，才允许继续退款流程。
      if (!["unknown", "approved", "executing"].includes(item.status))
        throw new ConflictException("当前状态不能继续退款执行");

      // 限制最多尝试执行 5 次，超过预算后要求人工核对业务记录。
      if (item.attempts >= 5)
        throw new BadRequestException("已达到本演示重试预算，请人工核对业务记录");

      // 如果此前模拟的是提交前故障，则清除故障配置，
      // 使下一次退款执行不再触发相同的演示异常。
      if (item.fault === "before_submit") {
        item.fault = "none";
        await this.db.put("case", item);
      }

      // 通知 LangGraph 恢复退款工作流。
      // 具体的回执核对和退款执行由后续工作流负责。
      await this.workflow.retry(id);

      // 重新查询并返回工作流处理后的最新申请状态。
      return this.getCase(actor, id);
    });
  }

  /** 执行售后申请调查：收集已确认材料，调用调查 Agent，并保存调查报告或失败信息。 */
  async investigate(actor: Actor, id: string, mode: Mode) {
    // 对当前申请加锁，避免并发调查导致申请状态冲突。
    return this.db.locked(`case:${id}`, async () => {
      // 获取当前售后申请，并校验访问权限。
      const item = await this.getCase(actor, id);

      // 如果申请已有正在执行的调查，则拒绝重复发起。
      if (item.investigation?.status === "running")
        throw new ConflictException("调查正在执行");

      // 构造申请对应的客户身份，用于读取该客户上传的材料。
      const customer = { ...actor, id: item.userId, role: "customer" as const };

      // 查询当前会话、当前订单下的有效材料。
      const docs = (
        await this.materialRepository.active(
          customer,
          item.conversationId,
          item.orderId,
        )
      ).filter((m) => m.confirmed && item.materialIds.includes(m.id));

      // 只保留客户已确认且属于当前申请的材料，避免使用无关或未确认的资料。
      try {
        // 调用调查 Agent，传入申请信息、已确认材料和运行模式。
        // 调查 Agent 负责整理事实、核对政策并生成调查报告。
        const report = await this.investigator.run(
          { ...actor, id: item.userId, role: "customer" },
          item,
          docs,
          mode,
        );

        // 通过领域聚合将调查报告关联到当前申请。
        new AfterSalesAggregate(item).attachInvestigation(report);
      } catch (e) {
        // 调查执行失败时，保存失败记录，而不是直接丢弃本次调查结果。
        item.investigation = {
          id: randomUUID(), // 本次调查记录的唯一 ID。
          at: new Date().toISOString(), // 调查失败时间。
          mode, // 本次调查使用的 AI 或 Replay 模式。
          status: "failed", // 标记调查状态为失败。
          caseVersion: item.version, // 记录本次调查对应的申请版本。
          facts: [], // 未生成有效事实记录。
          policies: [], // 未生成政策核对结果。
          summary: "", // 未生成调查摘要。
          unresolved: [], // 未生成待核实问题列表。
          files: [], // 未生成调查文件列表。
          error: (e as Error).message, // 保存失败原因，供后续排查。
        };
      }

      // 持久化调查结果，并返回更新后的售后申请。
      return this.db.put("case", item);
    });
  }

  async traces(actor: Actor, id: string, kind: "case" | "conversation") {
    if (kind === "case") await this.getCase(actor, id);
    else await this.conversation(actor, id);
    const field = kind === "case" ? "caseId" : "conversationId";
    // 对申请完成归属检查后，客户也能看到该申请的企业审批步骤。
    const result = await this.db.pool.query(
      `SELECT data FROM af_records WHERE kind='trace' AND tenant_id=$1 AND data->>$2=$3
       ORDER BY data->>'at' LIMIT 500`,
      [actor.tenantId, field, id],
    );
    return result.rows.map((row) => row.data as Trace);
  }
}

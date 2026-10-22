import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Storage } from "./storage.js";
import { Memories } from "./memory.service.js";
import { Materials } from "./materials.service.js";
import { ConsultationAgent } from "./agent.service.js";
import { CaseService } from "./case.service.js";
import { AfterSalesAggregate } from "./case.aggregate.js";
import { Knowledge } from "./knowledge.service.js";
import { MaterialRepository } from "./repositories.js";
import { buildProposal } from "./consultation-state.js";
import { accounts, policies } from "./fixtures.js";
import { deepSeekReady, modelName, multimodalReady } from "./config.js";
import { assertCustomer, assertOwner, assertVersion, canEdit } from "./domain.js";
import type {
  Actor,
  Bootstrap,
  Conversation,
  ConversationSummary,
  ConsultationEvent,
  Mode,
  CasePage,
  CaseStatus,
} from "../shared/types.js";

@Injectable()
export class ApplicationService {
  constructor(
    @Inject(Storage) readonly db: Storage,
    @Inject(Memories) readonly memory: Memories,
    @Inject(Materials) readonly materials: Materials,
    @Inject(ConsultationAgent) readonly agent: ConsultationAgent,
    @Inject(CaseService) readonly cases: CaseService,
    @Inject(Knowledge) readonly knowledge: Knowledge,
    @Inject(MaterialRepository) readonly materialRepository: MaterialRepository,
  ) {}

  async bootstrap(actor: Actor): Promise<Bootstrap> {
    return {
      actor,
      accounts,
      model: modelName,
      aiReady: deepSeekReady(),
      multimodalReady: multimodalReady(),
      orders:
        actor.role === "customer"
          ? await this.db.list("order", actor.tenantId, actor.id)
          : [],
      policies: policies.filter((p) => p.tenantId === actor.tenantId && p.active),
      preferences: actor.role === "customer" ? await this.memory.list(actor) : [],
    };
  }
  async conversationSummaries(actor: Actor): Promise<ConversationSummary[]> {
    if (actor.role !== "customer") return [];
    const result = await this.db.pool.query(
      `SELECT c.id, c.data->>'title' AS title, c.data->>'mode' AS mode,
        c.data->>'caseId' AS "caseId", c.data->>'createdAt' AS "createdAt",
        c.data->>'updatedAt' AS "updatedAt", a.data->>'status' AS "caseStatus"
       FROM af_records c LEFT JOIN af_records a ON a.kind='case'
        AND a.id=c.data->>'caseId' AND a.tenant_id=c.tenant_id AND a.user_id=c.user_id
       WHERE c.kind='conversation' AND c.tenant_id=$1 AND c.user_id=$2
        AND c.data->>'deletedAt' IS NULL ORDER BY c.updated_at DESC, c.id LIMIT 200`,
      [actor.tenantId, actor.id],
    );
    return result.rows;
  }

  /** 获取指定会话，并检查会话是否存在以及当前用户是否具有访问权限。 */
  async conversation(actor: Actor, id: string) {
    // 根据会话 ID 从数据库中查询会话记录。
    const c = await this.db.get<Conversation>("conversation", id);
    // 会话不存在时，抛出 404 异常。
    if (!c) throw new NotFoundException("会话不存在");
    // 校验当前用户是否为会话所有者，防止越权访问其他用户的会话。
    assertOwner(actor, c);
    // 返回通过权限校验的会话数据。
    return c;
  }

  async casePage(
    actor: Actor,
    input: {
      query: string;
      status?: CaseStatus;
      page: number;
      pageSize: number;
      sort: "updated" | "oldest";
    },
  ): Promise<CasePage> {
    const values: unknown[] = [actor.tenantId];
    const where = ["kind='case'", "tenant_id=$1"];
    if (actor.role === "customer") {
      values.push(actor.id);
      where.push(`user_id=$${values.length}`);
    }
    const counts = await this.db.pool.query(
      `SELECT data->>'status' AS status, count(*)::int AS count FROM af_records
       WHERE ${where.join(" AND ")} GROUP BY data->>'status'`,
      values,
    );
    if (input.query) {
      values.push(input.query.toLowerCase());
      where.push(
        `strpos(lower(concat_ws(' ',data->>'number',data->>'orderId',data->>'product',data->>'reason')), $${values.length}) > 0`,
      );
    }
    if (input.status) {
      values.push(input.status);
      where.push(`data->>'status'=$${values.length}`);
    }
    const clause = where.join(" AND ");
    const total = Number(
      (
        await this.db.pool.query(
          `SELECT count(*) FROM af_records WHERE ${clause}`,
          values,
        )
      ).rows[0].count,
    );
    const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)));
    const rows = await this.db.pool.query(
      `SELECT data FROM af_records WHERE ${clause}
       ORDER BY ${input.sort === "oldest" ? "data->>'createdAt' ASC" : "updated_at DESC"}, id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, input.pageSize, (page - 1) * input.pageSize],
    );
    return {
      items: rows.rows.map((r) => r.data),
      total,
      page,
      pageSize: input.pageSize,
      counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.count])),
    };
  }
  async renameConversation(actor: Actor, id: string, title: string) {
    return this.db.locked(`conversation:${id}`, async () => {
      const c = await this.conversation(actor, id);
      c.title = title.trim();
      c.customTitle = true;
      return this.db.put("conversation", c);
    });
  }
  async setConversationDeleted(actor: Actor, id: string, deleted: boolean) {
    assertCustomer(actor);
    return this.db.locked(`conversation:${id}`, async () => {
      const c = await this.conversation(actor, id);
      // 只移除会话入口，已提交申请仍需要原始消息和材料作为依据。
      if (deleted) c.deletedAt ??= new Date().toISOString();
      else {
        delete c.deletedAt;
        c.updatedAt = new Date().toISOString();
      }
      return this.db.put("conversation", c);
    });
  }
  private history(...args: Parameters<CaseService["history"]>) {
    return this.cases.history(...args);
  }
  /** 创建新的售后会话，校验用户权限和运行模式配置，并初始化会话状态。 */
  async createConversation(actor: Actor, mode: Mode) {
    // 确认当前用户具有客户权限。
    assertCustomer(actor);

    // AI 模式需要配置 DeepSeek API Key，否则提示使用 Replay 模式或完成配置。
    if (mode === "ai" && !process.env.DEEPSEEK_API_KEY)
      throw new BadRequestException(
        "尚未配置 DeepSeek，请选择 Replay 或配置本项目 .env",
      );

    // 生成当前时间，同时作为会话的创建时间和更新时间。
    const now = new Date().toISOString();

    // 初始化会话数据，保存到数据库并返回创建结果。
    return this.db.put("conversation", {
      id: randomUUID(), // 为会话生成唯一 ID。
      tenantId: actor.tenantId, // 所属租户 ID，用于多租户数据隔离。
      userId: actor.id, // 会话所属用户 ID。
      mode, // 会话运行模式：AI 或 Replay。
      title: "新的售后沟通", // 默认会话标题。
      messages: [], // 初始化为空消息列表。
      proposal: null, // 初始没有退款申请草稿。
      draftVersion: 0, // 草稿版本号从 0 开始。
      caseId: null, // 初始未关联正式售后申请。
      materialIds: [], // 初始化为空材料 ID 列表。
      createdAt: now, // 会话创建时间。
      updatedAt: now, // 最近一次更新时间。
    } satisfies Conversation);
  }

  /** 处理客户消息：保存用户输入、执行 Agent，并更新会话回复、证据和申请草稿。 */
  async send(
    actor: Actor,
    id: string,
    message: string,
    options: { signal?: AbortSignal; emit?: (event: ConsultationEvent) => void } = {},
  ) {
    // 确认当前用户具有客户权限。
    assertCustomer(actor);

    // 对同一会话加锁，避免并发发送消息导致会话状态冲突。
    return this.db.locked(`conversation:${id}`, async () => {
      // 获取会话并校验访问权限，同时检查请求是否已经取消。
      const c = await this.conversation(actor, id);
      options.signal?.throwIfAborted();

      // 限制会话中的消息总数，避免演示会话无限增长。
      if (c.messages.length >= 80)
        throw new BadRequestException("本会话已达演示轮次上限，请新建会话继续查询申请");

      // 将当前用户消息加入会话历史。
      c.messages.push({
        id: randomUUID(),
        role: "user",
        content: message,
        at: new Date().toISOString(),
      });

      // 如果用户未自定义标题，则取首条用户消息的前 25 个字符作为标题。
      if (!c.customTitle)
        c.title = c.messages.find((m) => m.role === "user")!.content.slice(0, 25);

      // 先持久化用户消息，确保后续 Agent 执行失败时仍保留本次提问。
      await this.db.put("conversation", c);

      try {
        // 执行 Agent，最长运行 150 秒。
        // 合并客户端断开信号与超时信号，任意一个触发都会取消执行。
        // emit 用于在执行期间向客户端推送 SSE 事件。
        const result = await this.agent.run(
          actor,
          c,
          message,
          options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(150000)])
            : AbortSignal.timeout(150000),
          options.emit,
        );

        // 保存 Agent 的回答，同时记录引用来源、执行 ID 和成功状态。
        c.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: result.answer,
          sourceIds: result.sources.map((s) => s.id),
          sources: result.sources,
          status: "accepted",
          runId: result.runId,
          at: new Date().toISOString(),
        });

        // 更新会话的证据资料，供后续页面展示或申请处理使用。
        c.evidence = result.sources;

        // 如果 Agent 生成了申请草稿，将尚未关联订单的有效资料绑定到订单。
        if (result.proposal) {
          const unbound = (await this.materialRepository.active(actor, id)).filter(
            (m) => !m.orderId,
          );

          // 优先使用会话原有草稿的订单 ID，否则使用本次新草稿的订单 ID。
          for (const m of unbound) {
            m.orderId = c.proposal?.order.id ?? result.proposal.order.id;
            await this.db.put("material", m);
          }
        }

        // 更新申请草稿，并递增草稿版本号。
        if (result.proposal) {
          c.proposal = result.proposal;
          c.draftVersion = (c.draftVersion ?? 0) + 1;
        }
      } catch (e) {
        // Agent 执行失败时，将错误记录为一条助手消息。
        // 此处不继续抛出异常，因此本轮仍会保存会话并正常返回。
        c.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: `本轮处理未完成：${(e as Error).message}。已有申请不受影响，可以重试查询。`,
          status: "error",
          at: new Date().toISOString(),
        });
      }

      // 更新会话修改时间，持久化最终状态并返回会话数据。
      c.updatedAt = new Date().toISOString();
      return this.db.put("conversation", c);
    });
  }

  async materialList(actor: Actor, conversationId: string) {
    const c = await this.conversation(actor, conversationId);
    const orderId = c.caseId
      ? (await this.getCase(actor, c.caseId)).orderId
      : c.proposal?.order.id;
    return this.materialRepository.active(actor, c.id, orderId);
  }

  /** 添加会话材料：检查编辑权限、避免重复上传，并更新会话草稿版本。 */
  async addMaterial(
    actor: Actor,
    id: string,
    bytes: Buffer,
    name: string,
    mime: string,
  ) {
    // 对当前会话加锁，避免并发上传导致材料数量或草稿状态冲突。
    return this.db.locked(`conversation:${id}`, async () => {
      // 获取会话，同时校验当前用户是否有权访问。
      const c = await this.conversation(actor, id);

      // 如果会话已关联售后申请，则检查该申请是否仍允许修改。
      if (c.caseId) {
        const item = await this.getCase(actor, c.caseId);
        canEdit(item);
      }

      // 获取当前会话的材料列表，并计算上传文件的 SHA-256 哈希值。
      const existing = await this.materialList(actor, id);
      const checksum = createHash("sha256").update(bytes).digest("hex");

      // 根据文件哈希判断是否重复上传，相同文件直接返回已有材料。
      const duplicate = existing.find((m) => m.checksum === checksum);
      if (duplicate) return duplicate;

      // 限制每个会话最多保存 10 份有效材料。
      if ((await this.materialRepository.active(actor, id)).length >= 10)
        throw new BadRequestException("每个会话最多保存 10 份材料，请先移除误传材料");

      // 调用材料服务保存文件，并生成对应的材料记录。
      const material = await this.materials.add(actor, c, bytes, name, mime);

      // 将新材料 ID 关联到会话，并递增草稿版本号。
      c.materialIds.push(material.id);
      c.draftVersion = (c.draftVersion ?? 0) + 1;

      // 持久化更新后的会话状态。
      await this.db.put("conversation", c);

      // 返回新创建的材料记录。
      return material;
    });
  }

  /** 确认指定材料，将用户提供的描述交由材料变更方法处理。 */
  async confirmMaterial(
    actor: Actor,
    id: string,
    description: string,
    version?: number,
  ) {
    // 调用统一的材料变更方法：
    // false 表示本次不是移除操作，description 为用户确认的材料描述。
    // version 为可选版本号，具体版本校验由 changeMaterial 处理。
    return this.changeMaterial(actor, id, version, false, description);
  }

  async removeMaterial(actor: Actor, id: string, version?: number) {
    return this.changeMaterial(actor, id, version, true);
  }
  /** 确认或移除材料：校验材料归属与申请版本，更新相关状态并重新计算申请草稿。 */
  private async changeMaterial(
    actor: Actor,
    id: string,
    version: number | undefined,
    remove: boolean,
    description = "",
  ) {
    // 先获取材料，确定其所属会话，以便使用对应的会话锁。
    const old = await this.materials.get(actor, id);

    // 先锁会话再读 caseId，覆盖“确认材料与提交申请同时发生”的窗口。
    return this.db.locked(`conversation:${old.conversationId}`, async () => {
      const c = await this.conversation(actor, old.conversationId);

      // 封装实际的材料变更操作，必要时还会在申请锁内执行。
      const apply = async () => {
        // 在锁内重新读取材料，避免使用过期的材料状态。
        const material = await this.materials.get(actor, id);

        // 已移除的材料不允许再次修改。
        if (material.removedAt) throw new ConflictException("材料已移除，请刷新列表");

        // 如果会话已关联售后申请，则获取申请记录和当前订单 ID。
        const item = c.caseId ? await this.getCase(actor, c.caseId) : null;
        const orderId = item?.orderId ?? c.proposal?.order.id;

        // 防止将其他订单的材料用于当前订单。
        if (material.orderId && orderId && material.orderId !== orderId)
          throw new ConflictException("这份材料属于另一笔订单，请切回对应订单处理");

        if (item) {
          // 已提交申请时，先检查申请是否仍允许编辑。
          canEdit(item);

          // 修改已提交申请的材料必须携带版本号，并验证版本是否匹配。
          // 避免使用旧页面的数据覆盖其他操作产生的变更。
          if (version === undefined)
            throw new ConflictException("请刷新申请，携带当前版本后修改材料");
          assertVersion(item, version);
        }

        // 记录变更前的材料说明，供旧版审批和交付报告核对。
        if (item) await this.history(item, actor, "材料变更前", material.name);

        // 根据操作类型生成新的材料状态：
        // 移除时记录移除时间；确认时更新用户描述并标记为已确认。
        const result = remove
          ? { ...material, removedAt: new Date().toISOString() }
          : { ...material, observation: description.trim(), confirmed: true };

        // 如果材料尚未绑定订单，则尝试关联当前草稿中的订单。
        result.orderId ??= c.proposal?.order.id;

        // 确认材料时，要求用户填写有效描述，且不能超过 2000 字。
        if (!remove && (!result.observation || result.observation.length > 2000))
          throw new BadRequestException("请填写不超过 2000 字的材料说明");

        // 移除材料时，将其 ID 从会话的材料列表中删除。
        if (remove) c.materialIds = c.materialIds.filter((value) => value !== id);

        // 材料发生变更后，递增会话草稿版本号。
        c.draftVersion = (c.draftVersion ?? 0) + 1;

        // 如果已有关联申请，则通过领域聚合更新申请的材料状态和版本。
        if (item)
          new AfterSalesAggregate(item).changeMaterial(actor, version!, id, remove);

        // 使用数据库事务统一保存材料、会话及关联申请的变更。
        await this.db.transaction(async (client) => {
          await this.db.put("material", result, client);
          await this.db.put("conversation", c, client);
          if (item) await this.db.put("case", item, client);
        });

        // 如果当前会话存在退款草稿，则根据变更后的材料重新计算申请信息。
        if (c.proposal) {
          c.proposal = buildProposal(
            c,
            c.proposal.order,
            "",
            // 重新核验当前租户的政策依据，避免使用失效政策。
            this.knowledge.revalidate(actor.tenantId, c.evidence ?? []),
            // 重新读取材料列表，确保草稿使用最新的材料状态。
            await this.materialList(actor, c.id),
          );

          // 保存重新计算后的退款申请草稿。
          await this.db.put("conversation", c);
        }

        if (item) {
          // 记录本次材料操作的历史，便于后续审计与追溯。
          await this.history(
            item,
            actor,
            remove ? "移除材料" : "确认材料",
            material.name,
          );

          // 保存包含材料变更历史的申请状态。
          await this.db.put("case", item);
        }

        // 返回本次确认或移除后的材料记录。
        return result;
      };

      // 如果会话已关联售后申请，则额外获取申请锁。
      // 保证材料变更与同一申请的其他修改操作不会并发执行。
      // 未关联申请时，只需要会话锁即可执行。
      return c.caseId ? this.db.locked(`case:${c.caseId}`, apply) : apply();
    });
  }
  getCase(...args: Parameters<CaseService["getCase"]>) {
    return this.cases.getCase(...args);
  }
  confirmedMaterials(...args: Parameters<CaseService["confirmedMaterials"]>) {
    return this.cases.confirmedMaterials(...args);
  }
  submit(...args: Parameters<CaseService["submit"]>) {
    return this.cases.submit(...args);
  }
  revise(...args: Parameters<CaseService["revise"]>) {
    return this.cases.revise(...args);
  }
  review(...args: Parameters<CaseService["review"]>) {
    return this.cases.review(...args);
  }
  cancel(...args: Parameters<CaseService["cancel"]>) {
    return this.cases.cancel(...args);
  }
  retry(...args: Parameters<CaseService["retry"]>) {
    return this.cases.retry(...args);
  }
  investigate(...args: Parameters<CaseService["investigate"]>) {
    return this.cases.investigate(...args);
  }
  traces(...args: Parameters<CaseService["traces"]>) {
    return this.cases.traces(...args);
  }
}

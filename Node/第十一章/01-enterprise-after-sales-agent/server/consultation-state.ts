import type {
  Conversation,
  Material,
  Order,
  Policy,
  Proposal,
} from "../shared/types.js";

/** 根据订单、政策依据和用户材料生成退款申请草稿，并检查申请条件及缺失资料。 */
export function buildProposal(
  conversation: Conversation,
  order: Order,
  message: string,
  policies: Policy[],
  materials: Material[],
  draftReason?: string,
): Proposal {
  // 判断本次订单是否与会话中已有草稿的订单一致。
  const sameOrder = conversation.proposal?.order.id === order.id;

  // 确定退款原因：优先使用明确传入的原因，其次从用户消息中提取，
  // 如果没有新原因且订单未变化，则沿用原草稿的原因。
  const reason =
    draftReason?.trim() ||
    (/损坏|裂|故障|坏了/.test(message)
      ? message.slice(0, 1000)
      : sameOrder
        ? conversation.proposal?.reason || ""
        : "");

  // 收集已检索到的政策类别，用于检查申请依据是否齐全。
  const categories = new Set(policies.map((p) => p.category));

  // 检查是否具备适用条件、材料要求和审批规则三类政策依据。
  // 将缺少的政策类别转换为用户可读的提示信息。
  const missing = (["eligibility", "materials", "approval"] as const)
    .filter((v) => !categories.has(v))
    .map(
      (v) =>
        `缺少${{ eligibility: "适用条件", materials: "材料要求", approval: "审批规则" }[v]}依据`,
    );

  // 如果没有明确的退款原因，则提示用户补充售后问题描述。
  if (!reason) missing.push("请描述这笔订单的售后问题");

  // 检查是否存在未删除、已确认且属于当前订单的图片材料。
  // 未绑定订单的图片也可以作为当前申请的候选材料。
  if (
    !materials.some(
      (m) =>
        !m.removedAt &&
        m.confirmed &&
        m.kind === "image" &&
        (!m.orderId || m.orderId === order.id),
    )
  )
    missing.push("损坏照片与确认说明");

  // 计算订单签收至今经过的天数，用于判断是否处于 7 天申请期限内。
  const days = (Date.now() - new Date(order.signedAt).getTime()) / 86400000;

  // 组装退款申请草稿，同时返回缺失资料和基础资格判断结果。
  return {
    order,

    // 可申请退款金额 = 订单实付金额 - 已退款金额，单位为分。
    amountCents: order.paidCents - order.refundedCents,

    reason,

    // 保存本次申请引用的政策 ID，便于后续追溯依据。
    sourceIds: policies.map((p) => p.id),

    // 记录尚未满足的资料要求，供前端提示用户补充。
    missing,

    // 基础资格判断：签收不超过 7 天、存在可退金额且政策类别齐全。
    // 注意：这里只判断基础资格，不包含退款原因和照片材料的完整性检查。
    eligible:
      days >= 0 &&
      days <= 7 &&
      order.paidCents > order.refundedCents &&
      categories.size === 3,
  };
}

/** 只保留成功的用户问答记录，过滤失败回复，并按长度预算截取最近的对话历史。 */
export function acceptedHistory(conversation: Conversation) {
  // 用于保存有效的用户提问与助手回答，每组包含两条消息。
  const pairs: { role: "user" | "assistant"; content: string }[][] = [];

  // 遍历会话消息，查找相邻的用户提问和助手回答。
  for (let i = 0; i < conversation.messages.length - 1; i++) {
    const user = conversation.messages[i],
      answer = conversation.messages[i + 1];

    // 只保留正常完成的问答，排除执行失败的助手消息。
    // 避免将错误提示作为 Agent 已经作出的业务结论传给模型。
    if (
      user.role === "user" &&
      answer.role === "assistant" &&
      answer.status !== "error" &&
      !answer.content.startsWith("本轮处理未完成：")
    ) {
      // 将有效的用户消息和助手回答组成一组。
      pairs.push([
        { role: "user", content: user.content },
        { role: "assistant", content: answer.content },
      ]);

      // 当前问答已处理完成，跳过对应的助手消息。
      i++;
    }
  }

  // 设置历史消息的字符预算，最多保留 24000 个字符。
  let budget = 24000;
  const selected: typeof pairs = [];

  // 从最近的问答开始筛选，优先保留最新的对话上下文。
  for (const pair of pairs.reverse()) {
    // 计算当前问答中用户消息和助手回答的总字符长度。
    const size = pair.reduce((n, m) => n + m.content.length, 0);

    // 当前问答超出剩余预算，或已保留 10 组问答时停止筛选。
    if (size > budget || selected.length === 10) break;

    // 扣除当前问答占用的字符预算。
    budget -= size;

    // 将问答插入开头，恢复原本从旧到新的时间顺序。
    selected.unshift(pair);
  }

  // 将问答分组展开为消息数组，供后续 Agent 模型调用使用。
  return selected.flat();
}

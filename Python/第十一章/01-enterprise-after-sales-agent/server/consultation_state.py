"""草稿与可接受历史的纯函数；订单不明时不继承其他订单的材料和原因。"""

import re
from .common import age_days, js_length


def build_proposal(conversation, order, message, policies, materials, draft_reason=None):
    old = conversation.get("proposal") or {}
    same = old.get("order", {}).get("id") == order["id"]
    reason = (draft_reason or "").strip() or (message[:1000] if re.search("损坏|裂|故障|坏了", message) else old.get("reason", "") if same else "")
    categories = {p["category"] for p in policies}
    labels = {"eligibility": "适用条件", "materials": "材料要求", "approval": "审批规则"}
    missing = [f"缺少{label}依据" for key, label in labels.items() if key not in categories]
    if not reason:
        missing.append("请描述这笔订单的售后问题")
    if not any(not m.get("removedAt") and m["confirmed"] and m["kind"] == "image" and (not m.get("orderId") or m["orderId"] == order["id"]) for m in materials):
        missing.append("损坏照片与确认说明")
    return dict(order=order, amountCents=order["paidCents"] - order["refundedCents"], reason=reason,
                sourceIds=[p["id"] for p in policies], missing=missing,
                eligible=0 <= age_days(order["signedAt"]) <= 7 and order["paidCents"] > order["refundedCents"] and len(categories) == 3)


def accepted_history(conversation):
    pairs, messages, i = [], conversation["messages"], 0
    while i < len(messages) - 1:
        user, answer = messages[i:i + 2]
        if user["role"] == "user" and answer["role"] == "assistant" and answer.get("status") != "error" and not answer["content"].startswith("本轮处理未完成："):
            pairs.append([{k: m[k] for k in ("role", "content")} for m in (user, answer)])
            i += 1
        i += 1
    selected, budget = [], 24000
    for pair in reversed(pairs):
        size = sum(js_length(m["content"]) for m in pair)
        if size > budget or len(selected) == 10:
            break
        budget -= size
        selected.insert(0, pair)
    return [m for pair in selected for m in pair]

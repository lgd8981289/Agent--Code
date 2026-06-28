"""分析任务特征，为模型路由提供结构化依据。"""

from typing import Any


def profile_task(task: dict[str, Any]) -> dict[str, Any]:
    """提取输入类型、规则匹配、推理复杂度和风险级别。"""
    text = task.get("userText") or ""
    input_types = [
        "text",
        *[item["type"] for item in task.get("attachments", [])],
    ]
    has_image = "image" in input_types
    has_order = bool(task.get("order"))
    asks_amount_check = "超过" in text and "阈值" in text
    mentions_policy = "规则" in text or "流程" in text
    asks_rewrite = "改写" in text or "客服回复" in text

    return {
        "id": task.get("id"),
        "userText": text,
        "inputTypes": input_types,
        "hasImage": has_image,
        "hasOrder": has_order,
        "asksRewrite": asks_rewrite,
        "deterministicRuleMatched": asks_amount_check and has_order,
        "reasoningComplexity": "high" if mentions_policy else "low",
        "riskLevel": "high" if has_order or "退款" in text else "low",
        "expectedOutput": task.get("expectedOutput", "text"),
    }

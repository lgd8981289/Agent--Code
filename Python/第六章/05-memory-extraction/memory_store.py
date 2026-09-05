"""
把审核通过的候选记忆写入 LangGraph Store。

本文件对应 Node 版的 memory-store.js。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


def memory_namespace(principal: dict[str, str]) -> tuple[str, ...]:
    """使用可信租户和用户身份确定长期记忆的 Namespace。"""

    return (
        "agent-course",
        "tenants",
        principal["tenantId"],
        "users",
        principal["userId"],
        "extracted-memories",
    )


def iso_now() -> str:
    """生成和 JavaScript Date.toISOString() 接近的 UTC 时间字符串。"""

    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def save_accepted_memories(
    store: Any,
    principal: dict[str, str],
    reviews: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """只把审核通过的候选写入 Store，并重新读取以验证结果。"""

    saved: list[dict[str, Any]] = []
    namespace = memory_namespace(principal)

    for review in reviews:
        candidate = review["candidate"]
        decision = review["decision"]

        if not decision["accepted"]:
            continue

        key = str(uuid4())
        value = {
            "content": candidate["content"],
            "category": candidate["category"],
            "sourceMessageId": candidate["sourceMessageId"],
            "evidenceQuote": candidate["evidenceQuote"],
            "createdAt": iso_now(),
        }

        store.put(namespace, key, value)
        item = store.get(namespace, key)
        saved.append(
            {
                "key": key,
                "value": item.value,
            }
        )

    return saved

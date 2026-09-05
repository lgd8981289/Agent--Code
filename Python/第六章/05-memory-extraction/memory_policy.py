"""
候选记忆的确定性审核策略。

本文件对应 Node 版的 memory-policy.js。

模型只负责“提出候选”，不能决定最终写入。
是否写入长期记忆，必须由应用层策略再检查一遍。
"""

from __future__ import annotations

import re
from typing import Any


SENSITIVE_PATTERNS = [
    re.compile(r"\b\d{17}[\dXx]\b"),
    re.compile(r"\b1[3-9]\d{9}\b"),
    re.compile(r"\b\d{16,19}\b"),
]


def reject(code: str, reason: str) -> dict[str, Any]:
    return {
        "accepted": False,
        "code": code,
        "reason": reason,
    }


def review_memory_candidate(
    candidate: dict[str, Any],
    messages: list[dict[str, Any]],
    options: dict[str, Any],
) -> dict[str, Any]:
    """审核一条候选记忆是否允许写入。

    模型负责提取，最终写入权限仍然掌握在确定性代码中。
    """

    if not options.get("memoryEnabled"):
        return reject("MEMORY_DISABLED", "用户没有开启长期记忆。")

    source = next(
        (
            message
            for message in messages
            if message.get("id") == candidate.get("sourceMessageId")
        ),
        None,
    )

    if source is None or source.get("role") != "user":
        return reject(
            "UNTRUSTED_SOURCE",
            "候选不是来自当前用户的原始消息。",
        )

    evidence_quote = candidate.get("evidenceQuote", "")
    if evidence_quote not in source.get("content", ""):
        return reject(
            "MISSING_EVIDENCE",
            "来源消息中找不到模型给出的原文证据。",
        )

    if candidate.get("duration") != "long_term":
        return reject(
            "NOT_LONG_TERM",
            "这条信息只适用于当前任务，或者真实性尚未确认。",
        )

    text_to_check = f"{candidate.get('content', '')}\n{evidence_quote}"
    if any(pattern.search(text_to_check) for pattern in SENSITIVE_PATTERNS):
        return reject(
            "SENSITIVE_DATA",
            "候选包含课程策略禁止自动保存的敏感信息。",
        )

    return {
        "accepted": True,
        "code": "ACCEPTED",
        "reason": "来源、保存范围和敏感信息检查均已通过。",
    }


def review_memory_candidates(
    candidates: list[dict[str, Any]],
    messages: list[dict[str, Any]],
    options: dict[str, Any],
) -> list[dict[str, Any]]:
    """批量审核模型提出的候选记忆。"""

    return [
        {
            "candidate": candidate,
            "decision": review_memory_candidate(candidate, messages, options),
        }
        for candidate in candidates
    ]

"""
使用结构化输出模型提出候选记忆。

本文件对应 Node 版的 memory-extractor.js。
"""

from __future__ import annotations

import json
import os
from typing import Any, Literal

from pydantic import BaseModel, Field


class MemoryCandidate(BaseModel):
    content: str = Field(description="整理后的候选记忆")
    category: Literal["preference", "fact"] = Field(
        description="候选属于用户偏好还是用户事实"
    )
    duration: Literal["long_term", "current_thread", "uncertain"] = Field(
        description="信息适合长期使用、只在当前会话使用，或者无法确认"
    )
    sourceMessageId: str = Field(description="候选记忆来自哪一条消息")
    evidenceQuote: str = Field(description="从来源消息中原样复制的证据，不得改写")


class CandidateSchema(BaseModel):
    candidates: list[MemoryCandidate]


def create_memory_extractor():
    """创建负责生成候选记忆的结构化输出模型。"""

    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先加载你已有的 .env。")

    try:
        from langchain_deepseek import ChatDeepSeek
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langchain-deepseek 依赖，请先执行：python -m pip install -e ."
        ) from exc

    model = ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
        max_retries=2,
        model_kwargs={
            "thinking": {"type": "disabled"},
        },
    )

    # Python 版 LangChain 直接传入 Pydantic Schema 即可约束结构化输出。
    return model.with_structured_output(CandidateSchema)


def normalize_candidates(response: Any) -> list[dict[str, Any]]:
    """把不同 Runnable 可能返回的结构统一成普通 dict 列表。"""

    if isinstance(response, CandidateSchema):
        return [candidate.model_dump() for candidate in response.candidates]

    if isinstance(response, dict):
        candidates = response.get("candidates", [])
        return [
            candidate.model_dump() if hasattr(candidate, "model_dump") else candidate
            for candidate in candidates
        ]

    candidates = getattr(response, "candidates")
    return [
        candidate.model_dump() if hasattr(candidate, "model_dump") else candidate
        for candidate in candidates
    ]


def extract_memory_candidates(
    extractor: Any,
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """从对话中提出候选记忆，不在此处直接写入 Store。"""

    response = extractor.invoke(
        [
            {
                "role": "system",
                "content": """你负责从对话中提出候选长期记忆，但没有最终保存权限。
分析用户偏好和用户事实，同时保留临时要求、未确认说法和敏感信息，让后续策略层决定是否保存。
duration 的判断规则：长期稳定信息使用 long_term；仅服务当前任务的信息使用 current_thread；转述、猜测或无法确认的信息使用 uncertain。
sourceMessageId 必须来自输入消息，evidenceQuote 必须从对应消息中原样复制。
不要把模型自己的推测改写成用户事实。""",
            },
            {
                "role": "user",
                "content": (
                    "请从下面的消息中提取候选记忆：\n"
                    f"{json.dumps(messages, ensure_ascii=False, indent=2)}"
                ),
            },
        ]
    )

    return normalize_candidates(response)

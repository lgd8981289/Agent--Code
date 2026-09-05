"""
从对话中提取候选记忆，并经过策略校验后写入 Store。

本文件对应 Node 版的 memory-extraction.js。
"""

from __future__ import annotations

import json
import sys
from typing import Any

from langgraph.store.memory import InMemoryStore

from conversation import conversation, principal, replay_candidates
from memory_extractor import create_memory_extractor, extract_memory_candidates
from memory_policy import review_memory_candidates
from memory_store import save_accepted_memories


def print_table(rows: list[dict[str, Any]]) -> None:
    """使用标准库输出一个简洁表格，替代 Node 版 console.table。"""

    if not rows:
        print("(empty)")
        return

    headers = list(rows[0].keys())
    widths = {
        header: max(
            len(str(header)),
            *(len(str(row.get(header, ""))) for row in rows),
        )
        for header in headers
    }

    print(" | ".join(header.ljust(widths[header]) for header in headers))
    print("-+-".join("-" * widths[header] for header in headers))

    for row in rows:
        print(
            " | ".join(
                str(row.get(header, "")).ljust(widths[header]) for header in headers
            )
        )


def print_candidates(candidates: list[dict[str, Any]]) -> None:
    print("\n========== 模型提出的候选记忆 ==========")
    print_table(
        [
            {
                "内容": candidate["content"],
                "范围": candidate["duration"],
                "来源": candidate["sourceMessageId"],
            }
            for candidate in candidates
        ]
    )


def print_reviews(reviews: list[dict[str, Any]]) -> None:
    print("\n========== 策略层审核结果 ==========")
    print_table(
        [
            {
                "候选": review["candidate"]["content"],
                "是否写入": "是" if review["decision"]["accepted"] else "否",
                "结果码": review["decision"]["code"],
                "原因": review["decision"]["reason"],
            }
            for review in reviews
        ]
    )


def main(mode: str | None = None) -> list[dict[str, Any]]:
    """运行记忆提取实验。

    主流程：
    1. 从对话中提取长期记忆候选；
    2. 根据用户授权和记忆策略审核候选；
    3. 将审核通过的记忆写入 Store；
    4. 输出最终持久化结果。
    """

    # 读取命令行参数，决定本次实验的运行模式。
    #
    # - replay：使用预先准备好的候选数据，方便稳定复现实验
    # - ai：调用大模型，从真实对话中提取记忆候选
    # - no-consent：模拟用户未授权长期记忆的场景
    mode = mode or (sys.argv[1] if len(sys.argv) > 1 else "replay")

    # 是否允许写入长期记忆。
    #
    # no-consent 模式下关闭记忆功能，
    # 用于验证“即使提取出了候选，也不能直接写入 Store”。
    memory_enabled = mode != "no-consent"

    # 创建内存版 Store，模拟 Agent 的长期记忆存储。
    store = InMemoryStore()

    # 获取待审核的记忆候选。这里分成了两个不同的模式：
    #
    # ai 模式：
    #   调用 Memory Extractor，让大模型从 conversation 中识别值得长期保存的信息。
    #
    # 其他模式：
    #   直接使用预先准备好的 replay_candidates，
    #   避免模型输出波动，方便观察后续审核与写入逻辑。
    candidates = (
        extract_memory_candidates(create_memory_extractor(), conversation)
        if mode == "ai"
        else replay_candidates
    )

    # 输出模型提取或预设得到的原始记忆候选。
    print_candidates(candidates)

    # 对候选记忆进行策略审核。
    #
    # 审核阶段并不会直接写入 Store，
    # 而是结合候选内容、原始对话以及用户是否开启记忆功能，
    # 判断每条候选最终应该接受还是拒绝。
    reviews = review_memory_candidates(
        candidates,
        conversation,
        {"memoryEnabled": memory_enabled},
    )

    # 输出每条候选的审核结果及拒绝/接受原因。
    print_reviews(reviews)

    # 只将审核通过的记忆真正写入 Store。
    #
    # principal 用于确定记忆所属的用户/主体，
    # 防止不同用户之间的长期记忆发生串扰。
    saved = save_accepted_memories(store, principal, reviews)

    # 查看本轮流程最终成功持久化到 Store 中的记忆。
    print("\n========== Store 最终写入结果 ==========")
    print(json.dumps(saved, ensure_ascii=False, indent=2))

    return saved


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)

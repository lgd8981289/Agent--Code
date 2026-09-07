"""
长期记忆生命周期演示入口。

本文件对应 Node 版的 memory-lifecycle.js。
"""

from __future__ import annotations

from datetime import datetime
from pprint import pprint
from typing import Any

from langgraph.store.memory import InMemoryStore

from memory_manager import (
    apply_memory_candidate,
    forget_memory,
    get_active_memory,
    memory_namespace,
    recall_memories,
)
from scenarios import candidates, principal


def show_state(title: str, result: dict[str, Any], store: Any, now: datetime) -> None:
    """在每次操作后重新读取，观察后续模型输入能够使用的记忆。"""

    print(f"\n========== {title} ==========")
    pprint(
        {
            "处理结果": result,
            "当前可用记忆": [
                {
                    "key": memory["key"],
                    "value": memory["value"],
                    "revision": memory["revision"],
                    "expiresAt": memory["expiresAt"],
                }
                for memory in recall_memories(store, principal, now)
            ],
        },
        width=120,
        sort_dicts=False,
    )


def main() -> None:
    """顺着同一个用户的记忆变化，验证去重、纠正、过期和主动删除。"""

    store = InMemoryStore()
    now = datetime.fromisoformat("2026-09-06T12:00:00+08:00")
    options = {"now": now}

    result = apply_memory_candidate(
        store,
        principal,
        candidates["initial"],
        **options,
    )
    show_state("首次保存：以后默认使用 Node.js", result, store, now)

    result = apply_memory_candidate(
        store,
        principal,
        candidates["repeat"],
        **options,
    )
    show_state("重复表达：后面还是用 nodejs", result, store, now)

    result = apply_memory_candidate(
        store,
        principal,
        candidates["temporary"],
        **options,
    )
    show_state("临时要求：这一次请用 Python", result, store, now)

    conflict = apply_memory_candidate(
        store,
        principal,
        candidates["correction"],
        **options,
    )
    show_state("新旧值冲突：等待确认是否修改长期偏好", conflict, store, now)

    # 模拟用户在记忆管理界面确认将 revision 1 的偏好改为 Python。
    result = apply_memory_candidate(
        store,
        principal,
        candidates["correction"],
        now=now,
        confirmed_revision=conflict["currentRevision"],
    )
    show_state("用户确认：以后默认改为 Python", result, store, now)

    result = apply_memory_candidate(
        store,
        principal,
        candidates["repeat"],
        **options,
    )
    show_state("延迟任务：重新处理修改前的旧消息", result, store, now)

    result = apply_memory_candidate(
        store,
        principal,
        candidates["contact"],
        **options,
    )
    show_state("限时记忆：9 月 7 日结束前只通过邮件联系", result, store, now)

    # 推进测试时钟，不需要真实等待到过期时间。
    after_expiry = datetime.fromisoformat("2026-09-08T00:00:00+08:00")
    show_state(
        "到期以后重新读取联系偏好",
        {
            "Store中仍有记录": bool(
                store.get(memory_namespace(principal), "contact_window")
            ),
            "正常读取结果": get_active_memory(
                store,
                principal,
                "contact_window",
                after_expiry,
            ),
        },
        store,
        after_expiry,
    )

    # 另一条偏好用于验证删除只影响选中的字段。
    apply_memory_candidate(
        store,
        principal,
        candidates["language"],
        now=after_expiry,
    )
    result = forget_memory(
        store,
        principal,
        "preferred_runtime",
        after_expiry,
    )
    show_state(
        "用户删除默认运行环境偏好",
        {
            **result,
            "Store原始读取": store.get(memory_namespace(principal), "preferred_runtime"),
        },
        store,
        after_expiry,
    )

    result = apply_memory_candidate(
        store,
        principal,
        candidates["correction"],
        now=after_expiry,
    )
    show_state("删除后：后台再次处理旧聊天记录", result, store, after_expiry)

    other_user = {**principal, "userId": "user-1002"}
    print("\n========== 换一名用户读取 ==========")
    pprint(recall_memories(store, other_user, after_expiry), width=120)


if __name__ == "__main__":
    main()

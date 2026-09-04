"""
用户画像长期记忆 Store。

本文件对应 Node 版的 profile-store.js。

Store 中长期记忆的定位方式是：

    Namespace + Key -> Value

其中 Namespace 由租户 ID 和用户 ID 组成，
不包含 thread_id。

因此同一用户的不同会话 Thread 可以读取同一份画像；
不同用户或不同租户会落到不同 Namespace，互相隔离。
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any


PROFILE_KEY = "current"
SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]+$")


def validate_principal(principal: dict[str, str]) -> None:
    """校验应用程序传入的租户和用户身份，避免把任意文本拼进 Namespace。"""

    for name, value in principal.items():
        if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
            raise RuntimeError(f"{name} 只能包含字母、数字、下划线和短横线。")


def profile_namespace(principal: dict[str, str]) -> tuple[str, ...]:
    """为一名用户生成固定的画像 Namespace。

    Namespace 不包含 thread_id，
    因此同一用户的不同 Thread 可以读取同一份画像。
    """

    validate_principal(principal)

    return (
        "agent-course",
        "tenants",
        principal["tenantId"],
        "users",
        principal["userId"],
        "profiles",
    )


def iso_now() -> str:
    """生成和 JavaScript Date.toISOString() 接近的 UTC 时间字符串。"""

    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def save_user_profile(
    store: Any,
    principal: dict[str, str],
    profile: dict[str, Any],
) -> dict[str, Any]:
    """把当前用户画像保存为一个 JSON 文档。"""

    value = {
        **profile,
        "updatedAt": iso_now(),
    }

    store.put(profile_namespace(principal), PROFILE_KEY, value)
    return value


def load_user_profile(store: Any, principal: dict[str, str]) -> dict[str, Any] | None:
    """使用精确 Namespace 和固定 Key 读取当前用户画像。"""

    item = store.get(profile_namespace(principal), PROFILE_KEY)

    if item is None:
        return None

    return item.value


def delete_user_profile(store: Any, principal: dict[str, str]) -> None:
    """删除当前用户画像，供课程实验恢复初始状态。"""

    store.delete(profile_namespace(principal), PROFILE_KEY)

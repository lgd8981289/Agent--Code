"""
长期记忆的生命周期管理规则。

本文件对应 Node 版的 memory-manager.js。

本节关注的不是“如何提取记忆”，而是记忆进入 Store 以后，
如何处理重复、冲突、过期、删除和隔离。
"""

from __future__ import annotations

import copy
from datetime import UTC, datetime
from typing import Any


MEMORY_KEYS = [
    "preferred_language",
    "preferred_runtime",
    "contact_window",
]

LONG_TERM = "long_term"
CURRENT_THREAD = "current_thread"

_MISSING = object()


def parse_offset_datetime(value: str) -> datetime:
    """解析必须带时区 offset 的 ISO 时间字符串。"""

    if not isinstance(value, str) or not value:
        raise ValueError("时间字段必须是非空字符串。")

    # Python 3.11 支持大部分 ISO 字符串；这里兼容常见的 Z 写法。
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)

    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("时间字段必须包含时区 offset。")

    return parsed.astimezone(UTC)


def ensure_datetime(value: datetime | None) -> datetime:
    """把当前处理时间统一成带时区的 UTC 时间。"""

    if value is None:
        return datetime.now(UTC)

    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)

    return value.astimezone(UTC)


def to_js_iso(value: datetime) -> str:
    """生成接近 JavaScript Date.toISOString() 的 UTC 毫秒时间。"""

    return ensure_datetime(value).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


def validate_identity(principal: dict[str, str]) -> dict[str, str]:
    tenant_id = principal.get("tenantId")
    user_id = principal.get("userId")

    if not isinstance(tenant_id, str) or not tenant_id:
        raise ValueError("tenantId 不能为空。")

    if not isinstance(user_id, str) or not user_id:
        raise ValueError("userId 不能为空。")

    return {
        "tenantId": tenant_id,
        "userId": user_id,
    }


def validate_key(key: str) -> str:
    if key not in MEMORY_KEYS:
        raise ValueError(f"未知记忆字段：{key}")

    return key


def validate_scope(scope: str) -> str:
    if scope not in [LONG_TERM, CURRENT_THREAD]:
        raise ValueError(f"未知记忆范围：{scope}")

    return scope


def validate_source(source: dict[str, Any]) -> dict[str, str]:
    thread_id = source.get("threadId")
    message_id = source.get("messageId")
    observed_at = source.get("observedAt")

    if not isinstance(thread_id, str) or not thread_id:
        raise ValueError("source.threadId 不能为空。")

    if not isinstance(message_id, str) or not message_id:
        raise ValueError("source.messageId 不能为空。")

    parse_offset_datetime(observed_at)

    return {
        "threadId": thread_id,
        "messageId": message_id,
        "observedAt": observed_at,
    }


def memory_namespace(
    principal: dict[str, str],
    collection: str = "lifecycle-memories",
) -> tuple[str, ...]:
    """按服务端已认证的身份划分范围，调用方不能使用模型提供的身份。"""

    identity = validate_identity(principal)

    return (
        "agent-course",
        "tenants",
        identity["tenantId"],
        "users",
        identity["userId"],
        collection,
    )


def normalize_candidate(input_candidate: dict[str, Any]) -> dict[str, Any]:
    """将少量已知别名统一成相同取值；这里不做任意文本的语义判断。"""

    candidate = copy.deepcopy(input_candidate)

    key = validate_key(candidate.get("key"))
    value = candidate.get("value")
    if not isinstance(value, str):
        raise ValueError("value 必须是字符串。")

    value = value.strip()
    if not value:
        raise ValueError("value 不能为空。")

    scope = validate_scope(candidate.get("scope"))
    expires_at = candidate.get("expiresAt")
    if expires_at is not None:
        parse_offset_datetime(expires_at)

    source = validate_source(candidate.get("source", {}))

    aliases = (
        {
            "node": "Node.js",
            "nodejs": "Node.js",
            "node.js": "Node.js",
            "python": "Python",
        }
        if key == "preferred_runtime"
        else (
            {"ts": "TypeScript", "typescript": "TypeScript", "python": "Python"}
            if key == "preferred_language"
            else {}
        )
    )

    value = aliases.get(value.lower(), value)

    return {
        "key": key,
        "value": value,
        "scope": scope,
        "expiresAt": expires_at,
        "source": source,
    }


def is_expired(memory: dict[str, Any], now: datetime) -> bool:
    """判断业务有效期；expiresAt 是本项目字段，不是 Store 的自动清理配置。"""

    expires_at = memory.get("expiresAt")

    return expires_at is not None and parse_offset_datetime(expires_at) <= ensure_datetime(
        now
    )


def apply_memory_candidate(
    store: Any,
    principal: dict[str, str],
    input_candidate: dict[str, Any],
    *,
    now: datetime | None = None,
    confirmed_revision: int | object = _MISSING,
) -> dict[str, Any]:
    """接住上一节审核后的候选记忆，决定最终的生命周期动作。

    结果可能是：
    - 新增
    - 忽略
    - 等待用户确认后更新

    注意：
    - confirmed_revision 只能来自应用层记录的“用户确认结果”，
      不能由记忆提取模型自行填写，否则模型可能绕过更新确认机制。
    - 当前教学案例使用串行执行。
      如果多个进程可能同时修改同一条记忆，需要配合数据库事务、
      CAS（Compare-And-Swap）或其他原子版本检查机制。
    """

    # 统一候选数据格式，确保后续生命周期判断使用规范化后的字段。
    candidate = normalize_candidate(input_candidate)
    now = ensure_datetime(now)

    # 正常长期记忆使用的 Namespace。
    namespace = memory_namespace(principal)

    # 删除后的生命周期阻断记录单独存放。
    # 一旦某个 key 被用户删除，这里可以阻止旧信息再次被自动写回。
    blocks = memory_namespace(principal, "lifecycle-blocks")

    # 同一类记忆使用固定 key，例如 profile.language、profile.city 等。
    key = candidate["key"]

    # 1. 删除阻断检查：
    # 如果该 key 曾被用户明确删除，则不允许候选记忆再次自动写入。
    if store.get(blocks, key):
        return {"action": "blocked_by_deletion"}

    # 2. Scope 检查：
    # 只有 long_term 类型的候选才允许进入长期 Store，
    # 当前 Thread 临时信息只在当前会话中使用。
    if candidate["scope"] != LONG_TERM:
        return {"action": "current_thread_only"}

    # 3. 过期检查：
    # 候选在真正写入前已经失效，就没有继续保存的必要。
    if is_expired(candidate, now):
        return {"action": "expired_candidate"}

    # 4. 来源时间检查：
    # observedAt 表示这条信息实际出现的时间，
    # 不允许出现“未来消息”，避免错误时间影响后续新旧版本判断。
    if parse_offset_datetime(candidate["source"]["observedAt"]) > now:
        raise RuntimeError("来源消息时间不能晚于当前处理时间。")

    # 查询当前已经保存的同 key 记忆。
    item = store.get(namespace, key)
    current = item.value if item else None

    # 5. 乐观锁 / Revision 校验：
    #
    # 用户确认修改时，应用层会把用户确认时看到的 revision
    # 作为 confirmed_revision 传回来。
    #
    # 如果此时 Store 中的 revision 已经发生变化，
    # 说明确认之后又有其他流程修改过这条数据。
    # 此时不能继续覆盖，否则可能造成并发更新丢失。
    if confirmed_revision is not _MISSING and confirmed_revision != (
        current.get("revision") if current else None
    ):
        return {"action": "stale_confirmation"}

    # 如果已经存在同 key 记忆，
    # 接下来需要判断候选是重复信息、旧信息，还是新的修改。
    if current:
        source_time = parse_offset_datetime(candidate["source"]["observedAt"])
        previous_time = parse_offset_datetime(current["source"]["observedAt"])

        # 候选信息比当前已保存信息更早：
        # 说明这是旧消息重新被提取出来，不允许覆盖新记忆。
        if source_time < previous_time:
            return {"action": "stale_source"}

        # value 和 expiresAt 都没有变化：
        # 认为是完全相同的记忆，不重复写入，也不增加 revision。
        if (
            current["value"] == candidate["value"]
            and current["expiresAt"] == candidate["expiresAt"]
        ):
            return {
                "action": "duplicate",
                "revision": current["revision"],
            }

        # 来源时间完全相同，但内容发生变化。
        # 这里不允许仅凭同一条来源消息产生的新提取结果覆盖旧结果，
        # 防止模型重新提取时产生不稳定结果。
        if source_time == previous_time:
            return {"action": "stale_source"}

        # 已存在记忆，并且新的候选值发生了变化：
        #
        # 如果应用层还没有提供 confirmed_revision，
        # 说明用户尚未确认这次修改，因此暂时不能更新 Store。
        if confirmed_revision is _MISSING:
            return {
                "action": "needs_confirmation",

                # 当前已经保存的值。
                "currentValue": current["value"],

                # 本次准备更新成的新值。
                "proposedValue": candidate["value"],

                # 把当前版本号返回给应用层。
                # 用户确认之后，需要携带这个 revision 再次调用本函数。
                "currentRevision": current["revision"],
            }

    # 能执行到这里，只有两种情况：
    #
    # 1. current 不存在：
    #    第一次创建这条长期记忆。
    #
    # 2. current 已存在：
    #    候选信息更新，并且用户已经基于正确 revision 完成确认。
    memory = {
        "value": candidate["value"],
        "source": candidate["source"],
        "expiresAt": candidate["expiresAt"],

        # 首次创建时记录 createdAt；
        # 后续更新时保留原始创建时间。
        "createdAt": current["createdAt"] if current else to_js_iso(now),

        # 每次成功写入都刷新更新时间。
        "updatedAt": to_js_iso(now),

        # revision 单调递增，用于识别并发更新和过期确认。
        "revision": (current["revision"] if current else 0) + 1,
    }

    # 写入最终通过生命周期检查的长期记忆。
    store.put(namespace, key, memory)

    # 根据之前是否已经存在记录，区分新增和更新。
    return {
        "action": "updated" if current else "created",
        "revision": memory["revision"],
    }


def get_active_memory(
    store: Any,
    principal: dict[str, str],
    key: str,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """读取一条当前仍然“有效”的长期记忆。

    所有正常读取都统一经过这里，从读取侧屏蔽：
    - 已被用户删除的记忆
    - 已经过期的记忆

    注意：
    这里负责的是“是否允许读取”，
    并不一定意味着底层 Store 中对应的数据已经被物理删除。
    """

    # 校验 Memory Key 的格式，
    # 防止非法 key 进入后续 Namespace 查询逻辑。
    key = validate_key(key)
    now = ensure_datetime(now)

    # 1. 先检查生命周期阻断记录。
    #
    # 用户删除某条记忆后，会在 lifecycle-blocks Namespace
    # 中留下对应的阻断记录。
    #
    # 即使正常 Memory Namespace 中还残留旧数据，
    # 只要 block 存在，这条记忆就不应该再次对外可见。
    block = store.get(memory_namespace(principal, "lifecycle-blocks"), key)

    if block:
        return None

    # 2. 从当前用户正常的 Memory Namespace 中读取记忆。
    item = store.get(memory_namespace(principal), key)

    # 3. 以下两种情况都视为“当前没有可用记忆”：
    #
    # - Store 中根本不存在这条记忆
    # - 记忆虽然仍然存在，但 expiresAt 已经过期
    #
    # 过期数据这里采用读取时过滤，
    # 是否进行物理清理可以交给独立的 GC / Cleanup 机制处理。
    if item is None or is_expired(item.value, now):
        return None

    # 返回统一的 Active Memory 结构：
    # key 来自 Store 索引，其余字段来自实际保存的 Memory Value。
    return {
        "key": key,
        **item.value,
    }


def recall_memories(
    store: Any,
    principal: dict[str, str],
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """按本案例的三个固定字段读取有效记忆，不进行语义检索。"""

    now = ensure_datetime(now)
    memories = []

    for key in MEMORY_KEYS:
        memory = get_active_memory(store, principal, key, now)
        if memory:
            memories.append(memory)

    return memories


def forget_memory(
    store: Any,
    principal: dict[str, str],
    key: str,
    now: datetime | None = None,
) -> dict[str, str]:
    """模拟用户删除入口：先阻止读写，再删除内容。

    重复执行可以重试未完成的删除。
    删除标记只保存控制信息，不保留旧偏好，也不作为模型上下文。
    """

    key = validate_key(key)
    now = ensure_datetime(now)
    blocks = memory_namespace(principal, "lifecycle-blocks")

    if not store.get(blocks, key):
        store.put(blocks, key, {"blockedAt": to_js_iso(now)})

    store.delete(memory_namespace(principal), key)
    return {"action": "deleted"}

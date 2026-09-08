"""企业知识库检索与证据校验逻辑。

这一层不直接调用模型。

它负责两件事：

1. 根据模型规划出的证据类型，构造更适合检索的查询词；
2. 对检索结果做确定性校验，过滤掉错误租户、错误证据类型、停用、未生效或过期的资料。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from fixtures import knowledge_chunks


EVIDENCE_TYPE_SEARCH_QUERY: dict[str, str] = {
    "review_rule": "当前退款金额人工审核阈值和生效规则",
    "material_requirement": "咖啡机申请退款需要提交哪些材料",
    "arrival_rule": "退款审核通过以后多久到账",
    "maintenance_policy": "咖啡机终身免费上门保养政策",
}


SUPPORTED_EVIDENCE_TYPES = set(EVIDENCE_TYPE_SEARCH_QUERY)


def build_search_query(question: str, evidence_type: str) -> str:
    """把用户原始问题改写成更适合知识库检索的查询。"""

    base_query = EVIDENCE_TYPE_SEARCH_QUERY.get(evidence_type, evidence_type)
    return f"{base_query}。原始问题：{question}"


def search_knowledge(
    *,
    principal: dict[str, Any],
    evidence_type: str,
    query: str,
) -> dict[str, Any]:
    """模拟知识库检索。

    注意：principal 由 Host 侧闭包传入，而不是让模型自己传。
    这样可以避免模型伪造 tenantId，越权查询其他租户资料。
    """

    tenant_id = principal.get("tenantId")

    if not tenant_id:
        raise RuntimeError("缺少当前租户身份，拒绝检索知识库。")

    if evidence_type not in SUPPORTED_EVIDENCE_TYPES:
        raise RuntimeError(f"不支持的证据类型：{evidence_type}")

    # 真实项目里，这里通常会调用向量库、全文检索或混合检索服务。
    # 为了让课程示例可离线验证，这里只按租户和 evidenceType 做固定过滤。
    candidates = [
        dict(chunk)
        for chunk in knowledge_chunks
        if chunk.get("tenantId") == tenant_id
        and chunk.get("evidenceType") == evidence_type
    ][:3]

    return {
        "ok": True,
        "query": query,
        "candidates": candidates,
    }


def parse_datetime(value: Any) -> datetime | None:
    """把知识库里的时间字符串转换成 datetime。"""

    if value is None:
        return None

    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None

    # 课程数据都是带时区的时间。
    # 这里对不带时区的异常输入做兜底，避免和 aware datetime 比较时报错。
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)

    return parsed


def reject_reason(
    *,
    chunk: dict[str, Any],
    principal: dict[str, Any],
    required_evidence: list[str],
    now: datetime,
) -> str | None:
    """判断一个候选知识片段是否能作为本轮回答证据。"""

    if chunk.get("tenantId") != principal.get("tenantId"):
        return "不属于当前租户"

    if chunk.get("evidenceType") not in required_evidence:
        return "不是当前问题需要的证据"

    if chunk.get("status") != "active":
        return "文档已经停用或被新版本替代"

    effective_at = parse_datetime(chunk.get("effectiveAt"))

    if effective_at is None or effective_at > now:
        return "文档尚未生效或生效时间无效"

    expires_at = parse_datetime(chunk.get("expiresAt"))

    if chunk.get("expiresAt") is not None and (expires_at is None or expires_at <= now):
        return "文档已经过期"

    return None


def append_unique(
    items: list[Any],
    additions: list[Any],
    get_key: Callable[[Any], Any] = lambda item: item,
) -> list[Any]:
    """按 key 合并数组，并保持原有顺序。"""

    seen = {get_key(item) for item in items}
    merged = [*items]

    for item in additions:
        key = get_key(item)

        if key not in seen:
            seen.add(key)
            merged.append(item)

    return merged


def assess_evidence(
    *,
    candidates: list[dict[str, Any]],
    principal: dict[str, Any],
    required_evidence: list[str],
    now: datetime,
) -> dict[str, Any]:
    """对当前累计候选资料做证据可用性判断。"""

    usable: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []

    for chunk in candidates:
        reason = reject_reason(
            chunk=chunk,
            principal=principal,
            required_evidence=required_evidence,
            now=now,
        )

        if reason:
            rejected.append(
                {
                    "id": str(chunk.get("id")),
                    "reason": reason,
                }
            )
            continue

        usable = append_unique(
            usable,
            [chunk],
            lambda item: item["id"],
        )

    available_types = {chunk["evidenceType"] for chunk in usable}
    missing = [
        evidence_type
        for evidence_type in required_evidence
        if evidence_type not in available_types
    ]

    return {
        "usable": usable,
        "rejected": rejected,
        "missing": missing,
    }

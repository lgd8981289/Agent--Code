"""Milvus 权限 Filter 构造。"""

from __future__ import annotations

from app.models import DemoUser


def escape_filter_value(value: str) -> str:
    """转义 Filter 字符串中的反斜杠和双引号。"""

    return value.replace("\\", "\\\\").replace('"', '\\"')


def equal(field: str, value: str) -> str:
    """构造 Milvus 字符串字段的等值表达式。"""

    return f'{field} == "{escape_filter_value(value)}"'


def build_permission_filter(user: DemoUser) -> str:
    """根据服务端确认的用户身份生成检索权限条件。

    管理员可查看当前租户全部文档，员工只能查看企业公开和本部门文档。
    """

    tenant = equal("tenant_id", user.tenant_id)
    active = "is_active == true"

    if user.role == "admin":
        return f"{tenant} and {active}"

    department = equal("department_id", user.department_id)
    return (
        f'{tenant} and {active} and '
        f'(visibility == "company" or {department})'
    )


def build_document_filter(
    tenant_id: str, document_id: str, active_only: bool = False
) -> str:
    """构造指定租户和文档的查询条件，可选择只查询生效版本。"""

    parts = [
        equal("tenant_id", tenant_id),
        equal("document_id", document_id),
    ]
    if active_only:
        parts.append("is_active == true")
    return " and ".join(parts)


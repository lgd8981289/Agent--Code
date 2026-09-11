"""演示身份模块。

本项目不是在讲登录系统，所以使用固定演示 Token。
HTTP 层只接收 x-demo-token，然后在服务端转换成可信 principal。
后续业务逻辑不读取用户提交的 userId，避免前端伪造身份。
"""

from __future__ import annotations

from typing import Any

from fastapi import Header, HTTPException


demo_users: list[dict[str, str]] = [
    {
        "tenantId": "agent-course",
        "userId": "user-linxia",
        "name": "林夏",
        "token": "demo-linxia",
    },
    {
        "tenantId": "agent-course",
        "userId": "user-chenzhou",
        "name": "陈舟",
        "token": "demo-chenzhou",
    },
]


def get_current_principal(
    x_demo_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """把演示 Token 转换成服务端可信身份。"""

    principal = next(
        (user for user in demo_users if user["token"] == x_demo_token),
        None,
    )

    if not principal:
        raise HTTPException(status_code=401, detail="缺少有效的演示身份。")

    return dict(principal)

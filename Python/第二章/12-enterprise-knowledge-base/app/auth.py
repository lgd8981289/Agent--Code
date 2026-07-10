"""演示身份和权限校验。"""

from __future__ import annotations

from app.exceptions import ForbiddenError, UnauthorizedError
from app.models import DemoUser


DEMO_USERS = [
    DemoUser(
        token="demo-bluewhale-admin",
        id="u-bluewhale-admin",
        name="陈晨",
        tenant_id="bluewhale",
        tenant_name="蓝鲸科技",
        department_id="platform",
        department_name="平台管理",
        role="admin",
    ),
    DemoUser(
        token="demo-bluewhale-customer-service",
        id="u-bluewhale-customer-service",
        name="林晓",
        tenant_id="bluewhale",
        tenant_name="蓝鲸科技",
        department_id="customer-service",
        department_name="客户服务部",
        role="employee",
    ),
    DemoUser(
        token="demo-bluewhale-finance",
        id="u-bluewhale-finance",
        name="周宁",
        tenant_id="bluewhale",
        tenant_name="蓝鲸科技",
        department_id="finance",
        department_name="财务部",
        role="employee",
    ),
    DemoUser(
        token="demo-starlight-admin",
        id="u-starlight-admin",
        name="许言",
        tenant_id="starlight",
        tenant_name="星河零售",
        department_id="platform",
        department_name="平台管理",
        role="admin",
    ),
]

DEMO_USER_BY_TOKEN = {user.token: user for user in DEMO_USERS}


def get_user_from_authorization(authorization: str | None) -> DemoUser:
    """根据 Bearer Token 恢复演示用户身份。

    后续权限 Filter 只使用服务端确认的 user，避免信任客户端传入的租户信息。
    """

    token = (
        authorization.removeprefix("Bearer ")
        if authorization and authorization.startswith("Bearer ")
        else None
    )
    user = DEMO_USER_BY_TOKEN.get(token or "")
    if not user:
        raise UnauthorizedError("请先选择一个演示身份。")
    return user


def assert_admin(user: DemoUser) -> None:
    """限制文档上传和版本更新接口只能由企业管理员调用。"""

    if user.role != "admin":
        raise ForbiddenError("只有企业管理员可以维护知识库文档。")


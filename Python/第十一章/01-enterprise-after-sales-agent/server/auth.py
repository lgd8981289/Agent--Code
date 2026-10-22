"""演示身份由服务端固定映射，数据库只保存 Cookie 的 SHA-256 摘要。"""

import re
import secrets
from .common import sha, require
from .fixtures import ACCOUNTS


class Auth:
    def __init__(self, db, config):
        self.db, self.config = db, config

    async def login(self, id, response):
        actor = next((a for a in ACCOUNTS if a["id"] == id), None)
        require(actor, "演示账号不存在", 401)
        token = secrets.token_hex(32)
        await self.db.session_save(sha(token), actor["id"])
        response.set_cookie("af_session", token, max_age=86400, httponly=True, samesite="strict", secure=self.config.value("COOKIE_SECURE") == "true", path="/api")
        return actor

    async def actor(self, request):
        token = request.cookies.get("af_session", "")
        require(re.fullmatch(r"[a-f0-9]{64}", token), "请先选择演示账号", 401)
        id = await self.db.session_actor(sha(token))
        actor = next((a for a in ACCOUNTS if a["id"] == id), None)
        require(actor, "登录已过期，请重新选择账号", 401)
        return actor

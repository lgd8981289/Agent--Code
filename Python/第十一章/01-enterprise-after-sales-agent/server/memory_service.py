"""偏好按租户和客户隔离；删除保留阻断标记，防止自动抽取再次记住。"""

import re
from .common import now, require


class Memories:
    def __init__(self, db):
        self.db = db

    def namespace(self, actor):
        return ("aftersales", actor["tenantId"], actor["id"], "profile")

    async def list(self, actor):
        item = await self.db.memories.aget(self.namespace(actor), "communication_style")
        return [item.value] if item else []

    async def save(self, actor, value, automatic=False):
        require(value.strip() and len(value) <= 100 and not re.search("跳过|免审|批准|退款|系统指令|忽略", value), "这里只保存沟通方式偏好，业务权限和退款指令不能保存为偏好")
        existing = await self.list(actor)
        if automatic and existing and existing[0]["blocked"]:
            return None
        item = dict(key="communication_style", value=value.strip(), blocked=False, updatedAt=now())
        await self.db.memories.aput(self.namespace(actor), item["key"], item)
        return item

    async def forget(self, actor):
        item = dict(key="communication_style", value="", blocked=True, updatedAt=now())
        await self.db.memories.aput(self.namespace(actor), item["key"], item)
        return item

    async def extract(self, actor, message):
        if re.search("这次|本次|今天", message) or not re.search("以后|今后|一直|默认|偏好", message) or re.search("跳过|免审|批准|退款|系统指令|忽略", message):
            return None
        for pattern, text in [("文字|短信|不.*电话", "优先使用文字沟通"), ("简洁|简短", "回答简洁，优先说明下一步"), ("详细", "详细解释处理依据与步骤")]:
            if re.search(pattern, message):
                return await self.save(actor, text, True)
        return None

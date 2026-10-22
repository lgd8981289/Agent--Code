"""统一当前有效材料和申请的归属检查，历史审计仍按 ID 读取原记录。"""

from .common import require
from .domain import assert_owner


class MaterialRepository:
    def __init__(self, db):
        self.db = db

    async def active(self, actor, conversation_id, order_id=None):
        items = await self.db.records("material", actor["tenantId"], actor["id"])
        return sorted([m for m in items if m["conversationId"] == conversation_id and not m.get("removedAt") and
                       (not order_id or not m.get("orderId") or m["orderId"] == order_id)], key=lambda m: (m["at"], m["id"]))


class CaseRepository:
    def __init__(self, db):
        self.db = db

    async def get(self, actor, id):
        item = await self.db.get("case", id)
        require(item, "申请不存在", 404)
        assert_owner(actor, item, True)
        return item

    async def for_customer(self, actor):
        return await self.db.records("case", actor["tenantId"], actor["id"])

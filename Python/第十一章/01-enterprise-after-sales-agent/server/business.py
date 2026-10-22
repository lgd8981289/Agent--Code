"""独立 MCP 服务使用的教学业务；回执和订单金额在同一事务中提交。"""

from .common import now, uid, require
from .domain import assert_customer, assert_executable, assert_owner, request_key


class Business:
    def __init__(self, db):
        self.db = db

    async def order(self, actor, id):
        order = await self.db.get("order", id)
        require(order, "订单不存在", 404)
        assert_owner(actor, order)
        return order

    async def orders(self, actor):
        assert_customer(actor)
        return await self.db.list("order", actor["tenantId"], actor["id"])

    async def lookup(self, actor, case_id):
        item = await self.db.get("case", case_id)
        require(item, "申请不存在", 404)
        assert_owner(actor, item)
        return await self.db.refund_get(request_key(item))

    async def refund(self, actor, case_id):
        assert_customer(actor)
        fail_after_commit = False
        async with self.db.transaction() as client:
            # 锁定申请和订单，审批校验、可退金额、回执写入处于一个事务。
            item = await self.db.get("case", case_id, client, True)
            require(item, "申请不存在", 404)
            assert_owner(actor, item)
            order = await self.db.get("order", item["orderId"], client, True)
            require(order, "订单不存在", 404)
            assert_owner(actor, order)
            key = request_key(item)
            existing = await self.db.refund_get(key, client)
            # 已有回执仍需先验证审批，幂等接口不能绕过业务权限。
            assert_executable(item, order, existing)
            if existing:
                return existing
            require(not (item["fault"] == "before_submit" and not item["faultConsumed"]), "演示故障：提交前业务服务暂不可用", 503)
            receipt = dict(id="RF-" + uid()[:8].upper(), requestKey=key, caseId=case_id, version=item["version"],
                           orderId=item["orderId"], amountCents=item["amountCents"], status="completed", at=now())
            await self.db.refund_put(receipt, client)
            order["refundedCents"] += item["amountCents"]
            await self.db.put("order", order, client)
            fail_after_commit = item["fault"] == "timeout_after_commit" and not item["faultConsumed"]
            if fail_after_commit:
                item["faultConsumed"] = True
                await self.db.put("case", item, client)
        # 事务提交后抛错，模拟业务成功而响应丢失；重试必须先查原请求回执。
        require(not fail_after_commit, "演示故障：业务已受理，但响应在返回前丢失；请查询原请求结果", 503)
        return receipt

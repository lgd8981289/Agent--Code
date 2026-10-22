"""提交、修改、审核与恢复的用例层；领域规则不依赖 HTTP 或模型。"""

from .common import uid, now, require, age_days
from .domain import (assert_amount, assert_customer, assert_owner, assert_reviewer,
                     assert_version, assert_review_note, can_edit)
from .case_aggregate import AfterSalesAggregate


class CaseService:
    def __init__(self, db, mcp, knowledge, workflow, trace, investigator, material_repository, case_repository):
        self.db, self.mcp, self.knowledge, self.workflow, self.trace = db, mcp, knowledge, workflow, trace
        self.investigator, self.material_repository, self.case_repository = investigator, material_repository, case_repository

    async def conversation(self, actor, id):
        c = await self.db.get("conversation", id)
        require(c, "会话不存在", 404)
        assert_owner(actor, c)
        return c

    async def get_case(self, actor, id):
        return await self.case_repository.get(actor, id)

    async def material_list(self, actor, id):
        c = await self.conversation(actor, id)
        order_id = (await self.get_case(actor, c["caseId"]))["orderId"] if c["caseId"] else (c.get("proposal") or {}).get("order", {}).get("id")
        return await self.material_repository.active(actor, id, order_id)

    async def history(self, item, actor, action, note):
        materials = [await self.db.get("material", id) for id in item["materialIds"]]
        item.setdefault("history", []).append(dict(id=uid(), at=item["updatedAt"], actorId=actor["id"], actorName=actor["name"],
            action=action, note=note, version=item["version"], status=item["status"], amountCents=item["amountCents"], reason=item["reason"],
            materials=[{k: m[k] for k in ("id", "name", "observation")} for m in materials if m]))

    async def confirmed_materials(self, actor, c):
        materials = await self.material_list(actor, c["id"])
        require(any(m["kind"] == "image" and m["confirmed"] for m in materials), "请先上传损坏照片并确认材料说明")
        return [m["id"] for m in materials if m["confirmed"]]

    async def submit(self, actor, conversation_id, input):
        assert_customer(actor)
        async with self.db.locked(f"conversation:{conversation_id}"):
            c = await self.conversation(actor, conversation_id)
            if c["caseId"]:
                return await self.get_case(actor, c["caseId"])
            proposal = c.get("proposal") or {}
            require(input["orderId"] == proposal.get("order", {}).get("id") and input["draftVersion"] == c.get("draftVersion", 0), "处理建议或材料已经变化，请刷新后重新确认当前草稿", 409)
            require(proposal.get("eligible") and len(proposal.get("sourceIds", [])) >= 3, "请先完成订单与三类政策依据的核对")
            evidence = self.knowledge.revalidate(actor["tenantId"], c.get("evidence", []))
            require(len({p["category"] for p in evidence}) == 3, "政策依据已经变化，请重新查询当前政策再提交")
            order = await self.mcp.call(actor, "get_order", {"orderId": input["orderId"]})
            assert_amount(input["amountCents"], order)
            require(age_days(order["signedAt"]) <= 7, "已超过本演示政策的申请时间范围，请人工核对")
            material_ids = await self.confirmed_materials(actor, c)
            id, timestamp = uid(), now()
            item = dict(id=id, number="AS-" + id[:8].upper(), tenantId=actor["tenantId"], userId=actor["id"],
                conversationId=c["id"], orderId=order["id"], product=order["product"], paidCents=order["paidCents"],
                amountCents=input["amountCents"], reason=input["reason"], version=1, status="waiting_review", materialIds=material_ids,
                sourceIds=[p["id"] for p in evidence], policySnapshots=evidence, reviews=[], refund=None, lastError=None,
                attempts=0, fault=input.get("fault", "none"), faultConsumed=False, investigation=None, createdAt=timestamp, updatedAt=timestamp)
            await self.history(item, actor, "提交申请", "客户核对金额、说明与材料后提交")
            async with self.db.transaction() as client:
                # 锁同一订单，覆盖不同会话同时申请的竞态；再查询全部未结束申请。
                latest = await self.db.get("order", order["id"], client, True)
                require(latest, "订单不存在", 404)
                assert_amount(input["amountCents"], latest)
                active = [v for v in await self.db.records("case", actor["tenantId"], client=client) if v["orderId"] == order["id"] and v["status"] not in ("completed", "rejected", "cancelled")]
                require(not active, "这个订单已有正在处理的申请，请到申请列表继续跟进", 409)
                await self.db.put("case", item, client)
                c["caseId"] = id
                await self.db.put("conversation", c, client)
            async def start(_):
                await self.workflow.start(id)
                return {"status": "waiting_review"}
            await self.trace.run(dict(actor=actor, conversationId=conversation_id, caseId=id), "workflow", "客户确认申请", {"amountCents": item["amountCents"], "version": 1}, start)
            return item

    async def revise(self, actor, id, input):
        assert_customer(actor)
        async with self.db.locked(f"case:{id}"):
            item = await self.get_case(actor, id)
            can_edit(item)
            assert_version(item, input["version"])
            order = await self.mcp.call(actor, "get_order", {"orderId": item["orderId"]})
            material_ids = await self.confirmed_materials(actor, await self.conversation(actor, item["conversationId"]))
            AfterSalesAggregate(item).revise(actor, input["version"], order, input["amountCents"], input["reason"], material_ids)
            await self.history(item, actor, "重新确认申请", "当前版本重新提交企业审核")
            await self.db.put("case", item)
            await self.workflow.supplemented(id)
            return item

    async def review(self, actor, id, input):
        assert_reviewer(actor)
        assert_review_note(input["decision"], input["note"])
        async with self.db.locked(f"case:{id}"):
            item = await self.get_case(actor, id)
            AfterSalesAggregate(item).review(actor, input)
            await self.history(item, actor, {"approve": "批准申请", "revise": "退回补充", "reject": "拒绝申请"}[input["decision"]], input["note"].strip())
            # 先保存审批事实，再恢复中断；重启时也能从业务记录继续。
            await self.db.put("case", item)
            async def decision(_):
                await self.workflow.decision(id)
                return await self.get_case(actor, id)
            return await self.trace.run(dict(actor=actor, caseId=id, conversationId=item["conversationId"]), "approval", "企业审核当前申请", input, decision)

    async def cancel(self, actor, id, version, reason):
        assert_customer(actor)
        require(3 <= len(reason.strip()) <= 500, "请填写 3 到 500 字的撤回原因")
        async with self.db.locked(f"case:{id}"):
            item = await self.get_case(actor, id)
            if not AfterSalesAggregate(item).cancel(actor, version, reason):
                return item
            await self.history(item, actor, "客户撤回", item["cancellationReason"])
            await self.db.put("case", item)
            await self.workflow.cancel(id)
            return item

    async def retry(self, actor, id):
        async with self.db.locked(f"case:{id}"):
            item = await self.get_case(actor, id)
            if item["status"] == "completed":
                return item
            require(item["status"] in ("unknown", "approved", "executing"), "当前状态不能继续退款执行", 409)
            require(item["attempts"] < 5, "已达到本演示重试预算，请人工核对业务记录")
            if item["fault"] == "before_submit":
                item["fault"] = "none"
                await self.db.put("case", item)
            await self.workflow.retry(id)
            return await self.get_case(actor, id)

    async def investigate(self, actor, id, mode):
        async with self.db.locked(f"case:{id}"):
            item = await self.get_case(actor, id)
            require((item.get("investigation") or {}).get("status") != "running", "调查正在执行", 409)
            customer = {**actor, "id": item["userId"], "role": "customer"}
            docs = [m for m in await self.material_repository.active(customer, item["conversationId"], item["orderId"]) if m["confirmed"] and m["id"] in item["materialIds"]]
            try:
                report = await self.investigator.run(customer, item, docs, mode)
                AfterSalesAggregate(item).attach_investigation(report)
            except Exception as error:
                item["investigation"] = dict(id=uid(), at=now(), mode=mode, status="failed", caseVersion=item["version"], facts=[], policies=[], summary="", unresolved=[], files=[], error=str(error))
            return await self.db.put("case", item)

    async def traces(self, actor, id, kind):
        await (self.get_case(actor, id) if kind == "case" else self.conversation(actor, id))
        field = "caseId" if kind == "case" else "conversationId"
        return sorted([t for t in await self.db.records("trace", actor["tenantId"]) if t.get(field) == id], key=lambda t: t["at"])[:500]

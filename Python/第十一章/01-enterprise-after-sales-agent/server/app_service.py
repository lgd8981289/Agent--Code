"""应用入口：会话、草稿与材料的锁定顺序保持为会话 → 申请。"""

import asyncio
import math
from collections import Counter
from .common import uid, now, sha, require
from .domain import assert_customer, assert_owner, assert_version, can_edit
from .case_aggregate import AfterSalesAggregate
from .consultation_state import build_proposal
from .fixtures import ACCOUNTS


class ApplicationService:
    def __init__(self, db, memory, materials, agent, cases, knowledge, material_repository, config):
        self.db, self.memory, self.materials, self.agent = db, memory, materials, agent
        self.cases, self.knowledge, self.material_repository, self.config = cases, knowledge, material_repository, config

    def __getattr__(self, name):
        # 申请用例在 CaseService，HTTP 层仍保持同一个应用入口。
        if name in ("submit", "get_case", "revise", "review", "retry", "cancel", "investigate", "traces"):
            return getattr(self.cases, name)
        raise AttributeError(name)

    async def bootstrap(self, actor):
        return dict(actor=actor, accounts=ACCOUNTS, model=self.config.model, aiReady=self.config.ai_ready,
            multimodalReady=self.config.multimodal_ready, orders=await self.db.list("order", actor["tenantId"], actor["id"]) if actor["role"] == "customer" else [],
            policies=[p for p in self.knowledge.policies if p["tenantId"] == actor["tenantId"] and p["active"]],
            preferences=await self.memory.list(actor) if actor["role"] == "customer" else [])

    async def conversation(self, actor, id):
        return await self.cases.conversation(actor, id)

    async def conversation_summaries(self, actor):
        if actor["role"] != "customer":
            return []
        result = []
        for c in await self.db.records("conversation", actor["tenantId"], actor["id"]):
            if c.get("deletedAt"):
                continue
            case = await self.db.get("case", c["caseId"]) if c["caseId"] else None
            result.append({**{k: c[k] for k in ("id", "title", "mode", "caseId", "createdAt", "updatedAt")}, "caseStatus": case["status"] if case and case["tenantId"] == actor["tenantId"] and case["userId"] == actor["id"] else None})
        return result[:200]

    async def case_page(self, actor, input):
        items = await self.db.records("case", actor["tenantId"], actor["id"] if actor["role"] == "customer" else None)
        counts = dict(Counter(i["status"] for i in items))
        if input.get("query"):
            query = input["query"].lower()
            items = [i for i in items if query in " ".join(i[k] for k in ("number", "orderId", "product", "reason")).lower()]
        if input.get("status"):
            items = [i for i in items if i["status"] == input["status"]]
        if input["sort"] == "oldest":
            items.sort(key=lambda i: (i["createdAt"], i["id"]))
        size, total = input["pageSize"], len(items)
        page = min(input["page"], max(1, math.ceil(total / size)))
        return dict(items=items[(page-1)*size:page*size], total=total, page=page, pageSize=size, counts=counts)

    async def rename_conversation(self, actor, id, title):
        async with self.db.locked(f"conversation:{id}"):
            c = await self.conversation(actor, id)
            c.update(title=title.strip(), customTitle=True)
            return await self.db.put("conversation", c)

    async def set_conversation_deleted(self, actor, id, deleted):
        assert_customer(actor)
        async with self.db.locked(f"conversation:{id}"):
            c = await self.conversation(actor, id)
            if deleted:
                c.setdefault("deletedAt", now())
            else:
                c.pop("deletedAt", None)
                c["updatedAt"] = now()
            return await self.db.put("conversation", c)

    async def create_conversation(self, actor, mode):
        assert_customer(actor)
        require(mode in ("replay", "ai"), "会话模式无效")
        require(mode != "ai" or self.config.ai_ready, "尚未配置 DeepSeek，请选择 Replay 或配置进程环境")
        timestamp = now()
        return await self.db.put("conversation", dict(id=uid(), tenantId=actor["tenantId"], userId=actor["id"], mode=mode,
            title="新的售后沟通", messages=[], proposal=None, draftVersion=0, caseId=None, materialIds=[], createdAt=timestamp, updatedAt=timestamp))

    async def send(self, actor, id, message, emit=None):
        assert_customer(actor)
        async with self.db.locked(f"conversation:{id}"):
            c = await self.conversation(actor, id)
            require(len(c["messages"]) < 80, "本会话已达演示轮次上限，请新建会话继续查询申请")
            c["messages"].append(dict(id=uid(), role="user", content=message, at=now()))
            if not c.get("customTitle"):
                c["title"] = next(m["content"] for m in c["messages"] if m["role"] == "user")[:25]
            await self.db.put("conversation", c)
            cancelled = None
            try:
                async with asyncio.timeout(150):
                    result = await self.agent.run(actor, c, message, emit)
                c["messages"].append(dict(id=uid(), role="assistant", content=result["answer"], sourceIds=[p["id"] for p in result["sources"]], sources=result["sources"], status="accepted", runId=result["runId"], at=now()))
                c["evidence"] = result["sources"]
                if result["proposal"]:
                    for m in await self.material_repository.active(actor, id):
                        if not m.get("orderId"):
                            m["orderId"] = (c.get("proposal") or {}).get("order", {}).get("id") or result["proposal"]["order"]["id"]
                            await self.db.put("material", m)
                    c["proposal"] = result["proposal"]
                    c["draftVersion"] += 1
            except (Exception, asyncio.CancelledError) as error:
                cancelled = error if isinstance(error, asyncio.CancelledError) else None
                c["messages"].append(dict(id=uid(), role="assistant", content=f"本轮处理未完成：{str(error) or '请求取消或超时'}。已有申请不受影响，可以重试查询。", status="error", at=now()))
            c["updatedAt"] = now()
            await self.db.put("conversation", c)
            if cancelled is not None:
                raise cancelled
            return c

    async def material_list(self, actor, id):
        return await self.cases.material_list(actor, id)

    async def add_material(self, actor, id, content, name, mime):
        async with self.db.locked(f"conversation:{id}"):
            c = await self.conversation(actor, id)
            if c["caseId"]:
                can_edit(await self.get_case(actor, c["caseId"]))
            checksum = sha(content)
            duplicate = next((m for m in await self.material_list(actor, id) if m.get("checksum") == checksum), None)
            if duplicate:
                return duplicate
            require(len(await self.material_repository.active(actor, id)) < 10, "每个会话最多保存 10 份材料，请先移除误传材料")
            material = await self.materials.add(actor, c, content, name, mime)
            c["materialIds"].append(material["id"])
            c["draftVersion"] += 1
            await self.db.put("conversation", c)
            return material

    async def confirm_material(self, actor, id, description, version=None):
        return await self.change_material(actor, id, version, False, description)

    async def remove_material(self, actor, id, version=None):
        return await self.change_material(actor, id, version, True)

    async def change_material(self, actor, id, version, remove, description=""):
        old = await self.materials.get(actor, id)
        async with self.db.locked(f"conversation:{old['conversationId']}"):
            c = await self.conversation(actor, old["conversationId"])
            async def apply():
                material = await self.materials.get(actor, id)
                require(not material.get("removedAt"), "材料已移除，请刷新列表", 409)
                item = await self.get_case(actor, c["caseId"]) if c["caseId"] else None
                order_id = item["orderId"] if item else (c.get("proposal") or {}).get("order", {}).get("id")
                require(not material.get("orderId") or not order_id or material["orderId"] == order_id, "这份材料属于另一笔订单，请切回对应订单处理", 409)
                if item:
                    can_edit(item)
                    require(version is not None, "请刷新申请，携带当前版本后修改材料", 409)
                    assert_version(item, version)
                    await self.cases.history(item, actor, "材料变更前", material["name"])
                result = {**material, **({"removedAt": now()} if remove else {"observation": description.strip(), "confirmed": True})}
                if not result.get("orderId") and order_id:
                    result["orderId"] = order_id
                require(remove or 0 < len(result["observation"]) <= 2000, "请填写不超过 2000 字的材料说明")
                if remove:
                    c["materialIds"] = [v for v in c["materialIds"] if v != id]
                c["draftVersion"] += 1
                if item:
                    AfterSalesAggregate(item).change_material(actor, version, id, remove)
                async with self.db.transaction() as client:
                    await self.db.put("material", result, client)
                    await self.db.put("conversation", c, client)
                    if item:
                        await self.db.put("case", item, client)
                if c.get("proposal"):
                    c["proposal"] = build_proposal(c, c["proposal"]["order"], "", self.knowledge.revalidate(actor["tenantId"], c.get("evidence", [])), await self.material_list(actor, c["id"]))
                    await self.db.put("conversation", c)
                if item:
                    await self.cases.history(item, actor, "移除材料" if remove else "确认材料", material["name"])
                    await self.db.put("case", item)
                return result
            if c["caseId"]:
                async with self.db.locked(f"case:{c['caseId']}"):
                    return await apply()
            return await apply()

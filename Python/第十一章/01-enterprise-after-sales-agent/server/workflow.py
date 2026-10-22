"""LangGraph 人工审核、补充材料与回执核对，使用固定 thread_id 持久化。"""

import asyncio
import logging
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command, interrupt
from .common import now, uid, require
from .domain import approval_for, assert_executable
from .case_aggregate import AfterSalesAggregate
from .fixtures import ACCOUNTS


class Flow(TypedDict, total=False):
    caseId: str
    route: str


class RefundWorkflow:
    def __init__(self, db, mcp, trace):
        self.db, self.mcp, self.trace = db, mcp, trace
        self.graph = self.build()
        self.tasks = set()

    async def item(self, id):
        item = await self.db.get("case", id)
        require(item, "申请不存在", 404)
        return item

    def config(self, id):
        return {"configurable": {"thread_id": f"refund-flow:{id}"}, "recursion_limit": 30}

    def build(self):
        async def review(state):
            item = await self.item(state["caseId"])
            if item["status"] == "cancelled":
                return {"route": "cancel"}
            answer = interrupt({"type": "approval", "caseId": item["id"], "version": item["version"]})
            current = await self.item(state["caseId"])
            if current["status"] == "cancelled":
                return {"route": "cancel"}
            saved = approval_for(current)
            return {"route": saved["decision"] if isinstance(answer, dict) and answer.get("version") == current["version"] and saved else "again"}

        async def supplement(state):
            if (await self.item(state["caseId"]))["status"] == "cancelled":
                return {"route": "cancel"}
            interrupt({"type": "materials", "caseId": state["caseId"]})
            return {"route": "cancel" if (await self.item(state["caseId"]))["status"] == "cancelled" else "review"}

        async def execute(state):
            result = await self.execute(state["caseId"])
            return {"route": "done" if result["status"] == "completed" else "retry"}

        async def retry(state):
            interrupt({"type": "reconcile", "caseId": state["caseId"]})
            return {}

        graph = StateGraph(Flow)
        for name, fn in (("review", review), ("supplement", supplement), ("execute", execute), ("retry", retry)):
            graph.add_node(name, fn)
        graph.add_edge(START, "review")
        graph.add_conditional_edges("review", lambda s: s["route"], {"approve": "execute", "revise": "supplement", "reject": END, "cancel": END, "again": "review"})
        graph.add_conditional_edges("supplement", lambda s: s["route"], {"cancel": END, "review": "review"})
        graph.add_conditional_edges("execute", lambda s: s["route"], {"done": END, "retry": "retry"})
        graph.add_edge("retry", "execute")
        return graph.compile(checkpointer=self.db.saver)

    async def initialize(self):
        async def recover(id, cancelled):
            try:
                async with self.db.locked(f"case:{id}"):
                    await (self.cancel(id) if cancelled else self.continue_flow(id))
            except Exception as error:
                logging.error("恢复任务失败：%s", error)
        for item in await self.db.records("case"):
            if item["status"] in ("approved", "executing", "cancelled"):
                task = asyncio.create_task(recover(item["id"], item["status"] == "cancelled"))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)

    async def start(self, id):
        await self.graph.ainvoke({"caseId": id}, self.config(id))

    async def decision(self, id):
        state = await self.graph.aget_state(self.config(id))
        if "supplement" in state.next:
            await self.supplemented(id)
            state = await self.graph.aget_state(self.config(id))
        if not state.values.get("caseId"):
            await self.start(id)
        await self.graph.ainvoke(Command(resume={"version": (await self.item(id))["version"]}), self.config(id))

    async def supplemented(self, id):
        state = await self.graph.aget_state(self.config(id))
        if "supplement" in state.next:
            await self.graph.ainvoke(Command(resume=True), self.config(id))

    async def continue_flow(self, id):
        state = await self.graph.aget_state(self.config(id))
        if not state.values.get("caseId") or "review" in state.next:
            return await self.decision(id)
        if "retry" in state.next:
            await self.graph.ainvoke(Command(resume=True), self.config(id))
        elif state.next:
            await self.graph.ainvoke(None, self.config(id))

    async def retry(self, id):
        await self.continue_flow(id)

    async def cancel(self, id):
        state = await self.graph.aget_state(self.config(id))
        if any(v in state.next for v in ("review", "supplement")):
            await self.graph.ainvoke(Command(resume={"version": (await self.item(id))["version"]}), self.config(id))

    async def execute(self, id):
        item = await self.item(id)
        if item["status"] == "completed":
            return item
        review = approval_for(item)
        require(item["status"] in ("approved", "executing", "unknown") and review and review["decision"] == "approve", "当前申请没有可执行的审批", 403)
        actor = next(a for a in ACCOUNTS if a["id"] == item["userId"] and a["tenantId"] == item["tenantId"])
        scope = dict(actor=actor, conversationId=item["conversationId"], caseId=id)

        async def run(parent_id):
            current = await self.item(id)
            current.update(status="executing", attempts=current["attempts"] + 1, updatedAt=now())
            await self.db.put("case", current)
            child = {**scope, "parentId": parent_id}
            try:
                order = await self.mcp.call(actor, "get_order", {"orderId": current["orderId"]})
                receipt = await self.trace.run(child, "mcp", "get_refund", {"caseId": id}, lambda _: self.mcp.call(actor, "get_refund", {"caseId": id}))
                assert_executable(current, order, receipt)
                if receipt is None:
                    receipt = await self.trace.run(child, "mcp", "submit_refund", {"caseId": id}, lambda _: self.mcp.call(actor, "submit_refund", {"caseId": id}))
                current = await self.item(id)
                AfterSalesAggregate(current).complete(order, receipt)
            except Exception as error:
                current = await self.item(id)
                current.update(status="unknown", lastError=str(error))
            current["updatedAt"] = now()
            await self.db.put("case", current)
            await self.db.put("event", dict(id=uid(), tenantId=actor["tenantId"], userId=actor["id"], caseId=id, at=current["updatedAt"], status=current["status"]))
            return current
        return await self.trace.run(scope, "workflow", "执行或核对退款", {"caseId": id, "version": item["version"]}, run)

    async def close(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

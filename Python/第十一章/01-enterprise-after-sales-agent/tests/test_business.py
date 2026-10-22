import asyncio
import unittest
from langchain_core.messages import AIMessage
from server.common import AppError
from server.domain import assert_amount, assert_owner
from server.fixtures import ACCOUNTS, seed_orders
from server.evaluation.regression import run_regressions
from server.workflow import RefundWorkflow
from .support import Harness, ScriptedModel


class BusinessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = await Harness().start()
        self.addAsyncCleanup(self.h.close)
        self.app, self.customer, self.reviewer = self.h.system.app, ACCOUNTS[0], ACCOUNTS[2]

    async def prepare(self, fault="none"):
        c = await self.app.create_conversation(self.customer, "replay")
        c = await self.app.send(self.customer, c["id"], "A1024 咖啡机到货外壳损坏申请退款")
        m = await self.app.add_material(self.customer, c["id"], (self.h.config.root / "samples/damaged-coffee-machine.png").read_bytes(), "照片.png", "image/png")
        await self.app.confirm_material(self.customer, m["id"], m["observation"])
        c = await self.app.conversation(self.customer, c["id"])
        return await self.app.submit(self.customer, c["id"], dict(orderId="A1024", draftVersion=c["draftVersion"], amountCents=350000, reason="到货外壳损坏申请退款", fault=fault))

    async def test_ten_business_regressions_and_baseline(self):
        items = await run_regressions(self.h.system, self.h.db, self.h.mcp, self.h.config)
        self.assertEqual(len(items), 10)
        self.assertEqual([(i["id"], i["actual"]) for i in items if i["status"] != "passed"], [])
        await self.h.db.reset_evaluation()
        self.h.system.agent.display_unit_bug = True
        items = await run_regressions(self.h.system, self.h.db, self.h.mcp, self.h.config)
        self.assertEqual([i["id"] for i in items if i["status"] != "passed"], ["order-answer"])

    async def test_workflow_recreation_preserves_review_and_retry(self):
        item = await self.prepare("timeout_after_commit")
        self.h.system.workflow.graph = RefundWorkflow(self.h.db, self.h.mcp, self.h.system.trace).graph
        state = await self.h.system.workflow.graph.aget_state(self.h.system.workflow.config(item["id"]))
        self.assertEqual(state.next, ("review",))
        result = await self.app.review(self.reviewer, item["id"], dict(version=1, decision="approve", note="批准"))
        self.assertEqual(result["status"], "unknown")
        workflow = RefundWorkflow(self.h.db, self.h.mcp, self.h.system.trace)
        self.h.system.cases.workflow = workflow
        result = await self.app.retry(self.customer, item["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(await self.h.db.refund_count(), 1)
        self.assertEqual(sum(n == "submit_refund" for _, n, _ in self.h.mcp.calls), 1)

    async def test_pre_submit_failure_and_retry_budget(self):
        item = await self.prepare("before_submit")
        result = await self.app.review(self.reviewer, item["id"], dict(version=1, decision="approve", note="批准"))
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(await self.h.db.refund_count(), 0)
        result = await self.app.retry(self.customer, item["id"])
        self.assertEqual(result["status"], "completed")

    async def test_material_change_stales_investigation_and_requires_confirmation(self):
        item = await self.prepare()
        item = await self.app.investigate(self.customer, item["id"], "replay")
        self.assertEqual(item["investigation"]["status"], "completed")
        await self.app.confirm_material(self.customer, item["materialIds"][0], "重新核对外壳裂痕", 1)
        changed = await self.app.get_case(self.customer, item["id"])
        self.assertEqual((changed["version"], changed["status"], changed["investigation"]["status"]), (2, "needs_materials", "stale"))
        with self.assertRaisesRegex(AppError, "版本"):
            await self.app.review(self.reviewer, item["id"], dict(version=1, decision="approve", note="批准"))

    async def test_cancel_soft_delete_and_restore(self):
        item = await self.prepare()
        await self.app.set_conversation_deleted(self.customer, item["conversationId"], True)
        self.assertEqual(await self.app.conversation_summaries(self.customer), [])
        self.assertEqual((await self.app.get_case(self.customer, item["id"]))["status"], "waiting_review")
        await self.app.set_conversation_deleted(self.customer, item["conversationId"], False)
        self.assertEqual(len(await self.app.conversation_summaries(self.customer)), 1)
        await self.app.cancel(self.customer, item["id"], 1, "客户撤回申请")
        with self.assertRaises(AppError):
            await self.app.review(self.reviewer, item["id"], dict(version=1, decision="approve", note="批准"))

    async def test_two_conversations_cannot_submit_same_order(self):
        await self.prepare()
        with self.assertRaisesRegex(AppError, "已有正在处理"):
            await self.prepare()

    async def test_amount_and_tenant_are_enforced(self):
        for value in (0, -1, True, .1, 350001, float("nan")):
            with self.assertRaises(AppError):
                assert_amount(value, seed_orders()[0])
        for actor in ACCOUNTS[1:]:
            with self.assertRaises(AppError):
                assert_owner(actor, seed_orders()[0])


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_langchain_tool_loop_without_network(self):
        model = ScriptedModel(responses=[
            AIMessage(content="", tool_calls=[{"name": "get_order", "args": {"orderId": "A1024"}, "id": "t1"}]),
            AIMessage(content="已核对本人订单 A1024，实付 3500 元，尚未退款。"),
        ])
        h = await Harness(model).start()
        self.addAsyncCleanup(h.close)
        c = await h.system.app.create_conversation(ACCOUNTS[0], "ai")
        c = await h.system.app.send(ACCOUNTS[0], c["id"], "查询 A1024 金额")
        self.assertEqual(c["messages"][-1]["status"], "accepted", c["messages"][-1])
        self.assertIn("get_order", model.tool_names)
        self.assertNotIn("submit_refund", model.tool_names)
        self.assertEqual(c["proposal"]["order"]["id"], "A1024")
        self.assertEqual(await h.db.refund_count(), 0)

    async def test_bad_citation_stays_out_of_accepted_history(self):
        model = ScriptedModel(responses=[AIMessage(content="已批准 [POL-NONEXISTENT]")])
        h = await Harness(model).start()
        self.addAsyncCleanup(h.close)
        c = await h.system.app.create_conversation(ACCOUNTS[0], "ai")
        c = await h.system.app.send(ACCOUNTS[0], c["id"], "查询政策")
        self.assertEqual(c["messages"][-1]["status"], "error")
        self.assertIn("未经核验", c["messages"][-1]["content"])
        from server.consultation_state import accepted_history
        self.assertEqual(accepted_history(c), [])

"""真实领域用例 + LangGraph，仅替换外部存储、MCP 传输与模型。"""

import asyncio
import copy
import shutil
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field
from server.application_factory import create_application
from server.business import Business
from server.config import ROOT, Config
from server.fixtures import seed_orders
from server.knowledge_service import Knowledge
from shared.business_tools import parse_tool_output


class MemoryStorage:
    def __init__(self):
        self.data, self.refunds, self.sessions, self.locks = {}, {}, {}, {}
        self.saver, self.memories = InMemorySaver(), InMemoryStore()
        self.tx_lock = asyncio.Lock()

    async def get(self, kind, id, client=None, lock=False):
        return copy.deepcopy(self.data.get((kind, id)))

    async def put(self, kind, value, client=None):
        key = (kind, value["id"])
        self.data.pop(key, None)
        self.data[key] = copy.deepcopy(value)
        return value

    async def records(self, kind, tenant=None, user=None, client=None):
        return [copy.deepcopy(v) for (k, _), v in reversed(list(self.data.items())) if k == kind and (tenant is None or v["tenantId"] == tenant) and (user is None or v["userId"] == user)]

    async def list(self, kind, tenant, user=None):
        return (await self.records(kind, tenant, user))[:200]

    async def refund_get(self, key, client=None):
        return copy.deepcopy(self.refunds.get(key))

    async def refund_put(self, receipt, client):
        assert receipt["requestKey"] not in self.refunds
        assert all(r["caseId"] != receipt["caseId"] for r in self.refunds.values())
        self.refunds[receipt["requestKey"]] = copy.deepcopy(receipt)

    async def refund_count(self):
        return len(self.refunds)

    async def session_save(self, hash, actor):
        self.sessions[hash] = actor

    async def session_actor(self, hash):
        return self.sessions.get(hash)

    @asynccontextmanager
    async def transaction(self):
        async with self.tx_lock:
            before = copy.deepcopy((self.data, self.refunds))
            try:
                yield self
            except BaseException:
                self.data, self.refunds = before
                raise

    @asynccontextmanager
    async def locked(self, key):
        async with self.locks.setdefault(key, asyncio.Lock()):
            yield

    async def reset_evaluation(self):
        self.data = {k: v for k, v in self.data.items() if k[0] not in ("case", "conversation", "material")}
        self.refunds.clear()
        for o in seed_orders():
            await self.put("order", o)

    async def close(self):
        pass


class BusinessBridge:
    """保持真实业务权限、事务和输出校验，只替换跨进程传输。"""
    def __init__(self, db):
        self.business, self.calls = Business(db), []

    async def call(self, actor, name, args=None):
        args = args or {}
        self.calls.append((actor["id"], name, copy.deepcopy(args)))
        if name == "list_orders":
            value = await self.business.orders(actor)
        elif name in ("get_order", "get_logistics"):
            value = await self.business.order(actor, args["orderId"])
            if name == "get_logistics":
                value = dict(orderId=value["id"], signedAt=value["signedAt"], tracking=value["tracking"], status=value["deliveryStatus"])
        else:
            value = await (self.business.refund(actor, args["caseId"]) if name == "submit_refund" else self.business.lookup(actor, args["caseId"]))
        return parse_tool_output(name, value)

    async def close(self):
        pass


class ScriptedModel(BaseChatModel):
    responses: list = Field(default_factory=list)
    seen: list = Field(default_factory=list)
    tool_names: list = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "offline-scripted-model"

    def bind_tools(self, tools, **kwargs):
        self.tool_names = [t.name if hasattr(t, "name") else t.get("name") for t in tools]
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        if not self.responses:
            raise RuntimeError("测试模型没有更多预设响应")
        return ChatResult(generations=[ChatGeneration(message=self.responses.pop(0))])


class Harness:
    def __init__(self, model=None, http=None):
        self.temporary = tempfile.TemporaryDirectory(prefix="aftersales-test-")
        root = Path(self.temporary.name)
        for relative in ("knowledge/policies.json", "samples/damaged-coffee-machine.png", "server/skills/material-review/SKILL.md"):
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        self.config = Config({"DEEPSEEK_API_KEY": "offline-test-key"} if model else {}, root=root)
        self.db = MemoryStorage()
        self.mcp = BusinessBridge(self.db)
        self.knowledge = Knowledge(self.config)
        self.system = create_application(self.db, self.mcp, self.knowledge, self.config, (lambda _: model) if model else None, http)

    async def start(self):
        await self.db.reset_evaluation()
        return self

    async def close(self):
        await self.system.workflow.close()
        self.temporary.cleanup()

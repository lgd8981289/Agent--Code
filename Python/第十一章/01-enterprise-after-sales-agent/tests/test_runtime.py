"""核对真实框架执行、取消与流式事件；模型和 ASR 网络均为显式替身。"""

import asyncio
import base64
import json
import unittest
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk
from server.agent_service import BudgetAndTrace
from server.common import AppError
from server.fixtures import ACCOUNTS
from server.voice.asr import Recognition
from .support import Harness, ScriptedModel


def call(name, args, id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": id}])


class TokenModel(ScriptedModel):
    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        for text in ("正在核对。", "\n\n", "尚未执行退款。"):
            yield ChatGenerationChunk(message=AIMessageChunk(content=text, id="stream-answer"))


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_stream_produces_paragraph_events_and_final_saved_answer(self):
        h = await Harness(TokenModel()).start()
        self.addAsyncCleanup(h.close)
        c = await h.system.app.create_conversation(ACCOUNTS[0], "ai")
        events = []
        result = await h.system.app.send(ACCOUNTS[0], c["id"], "查询售后流程", events.append)
        self.assertEqual(result["messages"][-1]["status"], "accepted", result["messages"][-1])
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "answer.delta"), result["messages"][-1]["content"])
        self.assertTrue(any(e["type"] == "answer.delta" for e in events))

    async def test_cancel_keeps_failed_round_and_does_not_create_draft(self):
        h = await Harness().start()
        self.addAsyncCleanup(h.close)
        started = asyncio.Event()
        async def slow(*args):
            started.set()
            await asyncio.Future()
        h.system.agent.run = slow
        c = await h.system.app.create_conversation(ACCOUNTS[0], "replay")
        task = asyncio.create_task(h.system.app.send(ACCOUNTS[0], c["id"], "开始查询"))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        saved = await h.system.app.conversation(ACCOUNTS[0], c["id"])
        self.assertEqual(saved["messages"][-1]["status"], "error")
        self.assertIsNone(saved["proposal"])

    async def test_deepagents_workers_deliver_real_validated_files(self):
        results = [
            {"findings": [{"file": "/inputs/sample-2.txt", "quote": "无法判断运输责任", "finding": "责任待人工核对"}], "unresolved": ["损坏责任"]},
            {"findings": [{"file": "/inputs/sample-2.txt", "quote": "已批准退款", "finding": "资料备注不代替真实审批"}], "unresolved": []},
        ]
        supervisor = ScriptedModel(responses=[call("fact-checker", {}, "s1"), call("policy-checker", {}, "s2"), AIMessage(content="两项已核对")])
        workers = []
        for role, result in zip(("fact-checker", "policy-checker"), results):
            workers.append(ScriptedModel(responses=[
                call("read_file", {"file_path": "/skills/material-review/SKILL.md"}, role+"1"),
                call("read_file", {"file_path": "/inputs/sample-2.txt"}, role+"2"),
                call("write_file", {"file_path": f"/staging/{role}.json", "content": json.dumps(result, ensure_ascii=False)}, role+"3"),
                call("read_file", {"file_path": f"/staging/{role}.json"}, role+"4"),
                AIMessage(content="文件已交付"),
            ]))
        h = await Harness().start()
        self.addAsyncCleanup(h.close)
        models = iter([supervisor, *workers])
        h.system.investigator.model_factory = lambda: next(models)
        order = (await h.db.records("order"))[0]
        item = dict(id="fixture-case", conversationId="fixture-conversation", orderId=order["id"], amountCents=350000, reason="外壳损坏", status="waiting_review", version=1)
        report = await h.system.investigator.run(ACCOUNTS[0], item, [], "ai")
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["facts"], results[0]["findings"])
        self.assertEqual(report["policies"], results[1]["findings"])
        self.assertTrue((h.config.root / "workspaces" / item["id"] / report["id"] / "report.json").is_file())

    async def test_asr_real_event_handler_with_fake_socket(self):
        events, ready = [], asyncio.Event()
        class Socket:
            def __init__(self):
                self.queue = asyncio.Queue()
                self.transport = type("Transport", (), {"get_write_buffer_size": lambda _: 0})()
                self.sent = []
            async def send(self, raw):
                event = json.loads(raw)
                self.sent.append(event)
                if event["type"] == "session.update":
                    await self.queue.put({"type": "session.updated"})
                if event["type"] == "input_audio_buffer.append":
                    await self.queue.put({"type": "conversation.item.input_audio_transcription.text", "item_id": "sentence-1", "text": "A 一 零", "stash": " 二 四"})
                if event["type"] == "session.finish":
                    await self.queue.put({"type": "conversation.item.input_audio_transcription.completed", "item_id": "sentence-1", "transcript": "A 一 零 二 四"})
                    await self.queue.put({"type": "session.finished"})
            def __aiter__(self): return self
            async def __anext__(self): return json.dumps(await self.queue.get())
        socket = Socket()
        class Connection:
            async def __aenter__(self): return socket
            async def __aexit__(self, *args): pass
        async def emit(name, data):
            events.append((name, data))
            if name == "asr.ready": ready.set()
        rec = Recognition(emit, {"url": "wss://example.invalid", "key": "fake"}, connector=lambda *a, **k: Connection())
        await asyncio.wait_for(ready.wait(), 2)
        await rec.append(base64.b64encode(b"\0\0"*3200).decode())
        await rec.finish()
        await asyncio.wait_for(rec.done, 2)
        self.assertEqual(events[-1], ("asr.final", {"text": "A 一 零 二 四"}))
        self.assertEqual(socket.sent[0]["session"]["sample_rate"], 16000)
        self.assertEqual(socket.sent[-1]["type"], "session.finish")

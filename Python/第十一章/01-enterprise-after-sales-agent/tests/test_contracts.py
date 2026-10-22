import asyncio
import copy
import importlib.util
import json
import struct
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from langchain_core.messages import AIMessage
from server.answer_stream import AnswerStream
from server.common import AppError, cleanup_resources
from server.config import Config
from server.consultation_state import build_proposal, accepted_history
from server.evaluation_service import Evaluations
from server.fixtures import ACCOUNTS, seed_orders
from server.investigation_service import validate_findings, validate_investigation_tool
from server.knowledge.catalog import policy_hash
from server.knowledge.segmenter import tokens
from server.knowledge_service import Knowledge, retrieve
from server.knowledge.milvus import ZhipuRanking, MilvusPolicies, policy_filter
from server.materials_service import Materials
from server.trace import Traces
from server.voice.asr import asr_config, Recognition
from server.voice.normalize import normalize_order_ids
from server.voice.wav import normalize_wav
from shared.business_tools import parse_tool_output
from .support import Harness, ScriptedModel


def wav():
    return b"RIFF" + struct.pack("<I", 0xffffffff) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16) + b"data" + struct.pack("<I", 0xffffffff) + b"\0\0"*100


class ContractTests(unittest.TestCase):
    def test_exact_policy_hash_tokenization_and_bm25_baseline(self):
        baseline = json.loads(Path(__file__).with_name("knowledge_baseline.json").read_text())
        policies = Knowledge(Config({})).policies
        self.assertEqual([[p["id"], policy_hash(p)] for p in policies], baseline["policyHashes"])
        self.assertEqual([tokens(p["title"]+p["content"]) for p in policies], baseline["policyTokens"])
        for sample in baseline["queries"]:
            self.assertEqual(tokens(sample["query"]), sample["tokens"])
            result = retrieve(sample["query"], "xinghe", catalog=policies)
            self.assertEqual([p["id"] for p in result], [p["id"] for p in sample["results"]])
            for a, b in zip(result, sample["results"]):
                self.assertAlmostEqual(a["score"], b["score"], places=12)
        self.assertEqual(retrieve("退款", "other-company"), [])

    def test_tool_output_contract_rejects_invalid_money_and_receipt(self):
        order = seed_orders()[0]
        self.assertEqual(parse_tool_output("get_order", order), order)
        self.assertIsNone(parse_tool_output("get_refund", None))
        for value in ({"id": "A1024"}, {**order, "paidCents": 3.5}, {**order, "paidCents": True}):
            with self.assertRaises(ValueError):
                parse_tool_output("get_order", value)
        with self.assertRaises(ValueError):
            parse_tool_output("submit_refund", None)

    def test_cross_order_materials_reason_and_history_budget(self):
        k, orders = Knowledge(Config({})), seed_orders()
        c = {"proposal": None, "messages": []}
        photo = dict(kind="image", confirmed=True, orderId="A1024")
        p = build_proposal(c, orders[0], "咖啡机裂了", [v for v in k.policies if v["active"]], [photo])
        c["proposal"] = p
        changed = build_proposal(c, orders[1], "再看 A1026", k.policies[:3], [photo])
        self.assertEqual(changed["reason"], "")
        self.assertIn("损坏照片与确认说明", changed["missing"])
        c["messages"] = [{"role": "user", "content": "问"}, {"role": "assistant", "content": "答", "status": "accepted"}, {"role": "user", "content": "失败问"}, {"role": "assistant", "content": "错误", "status": "error"}]
        self.assertEqual(accepted_history(c), [{"role": "user", "content": "问"}, {"role": "assistant", "content": "答"}])

    def test_citations_are_validated_at_paragraph_boundary(self):
        events = []
        output = AnswerStream({"POL-APPROVAL-V4": {}}, events.append)
        output.push("见 [POL-APP")
        self.assertEqual(events, [])
        output.push("ROVAL-V4]。\n\n")
        self.assertEqual(events[-1]["type"], "answer.delta")
        output.push("[POL-FAKE]")
        with self.assertRaisesRegex(ValueError, "未经核验"):
            output.finish()
        output.reset()
        self.assertEqual(events[-1], {"type": "answer.reset"})

    def test_wav_placeholders_and_order_id_normalization(self):
        result = normalize_wav(wav())
        self.assertEqual(struct.unpack_from("<I", result, 4)[0], len(result)-8)
        self.assertEqual(struct.unpack_from("<I", result, 40)[0], 200)
        self.assertEqual(normalize_order_ids("订单 A 一 零 二 四，金额三千五百"), "订单 A1024，金额三千五百")
        with self.assertRaises(ValueError):
            normalize_wav(b"invalid")

    def test_config_and_asr_region_mapping(self):
        config = Config({"DASHSCOPE_API_KEY": "fake", "DASHSCOPE_BASE_URL": "https://space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"})
        self.assertTrue(config.multimodal_ready)
        self.assertEqual(asr_config(config.env)["url"], "wss://space.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime")
        self.assertTrue(Config({"PORT": "0", "POSTGRES_URI": "sqlite:///data"}).inspect()["errors"])
        for base in ("http://dashscope.aliyuncs.com/compatible-mode/v1", "https://u:p@dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/api/v1"):
            with self.assertRaises(AppError):
                asr_config({"DASHSCOPE_API_KEY": "fake", "DASHSCOPE_BASE_URL": base})

    def test_investigation_paths_and_verbatim_quotes(self):
        inputs = {"/inputs/a.txt": "只能提交审批"}
        with self.assertRaisesRegex(AppError, "引用"):
            validate_findings({"findings": [{"file": "/inputs/a.txt", "quote": "已批准", "finding": "批准"}], "unresolved": []}, inputs)
        for name, args in [("glob", {"pattern": "*"}), ("read_file", {"file_path": "/inputs/../secret"}), ("write_file", {"file_path": "/staging/policy-checker.json"}), ("ls", {"path": "/inputs/{a,b}"})]:
            with self.assertRaises(ValueError):
                validate_investigation_tool(name, args, "fact-checker", list(inputs))


class AsyncContracts(unittest.IsolatedAsyncioTestCase):
    async def test_vision_transcription_and_audio_requests(self):
        h = await Harness().start()
        self.addAsyncCleanup(h.close)
        config = Config({"DASHSCOPE_API_KEY": "fake-key", "DASHSCOPE_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "VISION_MODEL": "explicit-vision"}, root=h.config.root)
        http = type("Http", (), {})()
        http.json, http.download = AsyncMock(), AsyncMock(return_value=wav())
        materials = Materials(h.db, config, http)
        http.json.return_value = {"choices": [{"message": {"content": '{"observation":"可见裂痕，责任待核对"}'}}]}
        c = await h.system.app.create_conversation(ACCOUNTS[0], "replay")
        c["mode"] = "ai"
        result = await materials.add(ACCOUNTS[0], c, b"\x89PNG\r\n\x1a\nfixture", "../a.png", "image/png")
        self.assertFalse(result["confirmed"])
        self.assertEqual(http.json.call_args.args[1]["model"], "explicit-vision")
        self.assertNotIn("/", result["name"])
        http.json.return_value = {"choices": [{"message": {"content": "A1024 咖啡机损坏"}}]}
        self.assertEqual((await materials.transcribe(b"fixture", "audio/x-wav;codec=pcm"))["text"], "A1024 咖啡机损坏")
        self.assertTrue(http.json.call_args.args[1]["asr_options"]["enable_itn"])
        http.json.return_value = {"output": {"audio": {"url": "http://a.oss-cn-beijing.aliyuncs.com/test.wav"}}}
        audio = await materials.speak_audio("请核对材料")
        self.assertEqual(audio[:4], b"RIFF")
        self.assertEqual(http.json.call_args.args[0], "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation")
        self.assertTrue(http.download.call_args.args[0].startswith("https://"))
        http.json.return_value = {"output": {"audio": {"url": "http://127.0.0.1/private"}}}
        with self.assertRaisesRegex(AppError, "无效地址"):
            await materials.speak("测试")

    async def test_diagnostic_failure_and_cleanup_preserve_original_error(self):
        db = type("Db", (), {"put": AsyncMock(side_effect=RuntimeError("db unavailable"))})()
        trace = Traces(db)
        with self.assertLogs(level="WARNING"):
            result = await trace.run({"actor": ACCOUNTS[0]}, "mcp", "tool", {}, AsyncMock(return_value="receipt"))
        self.assertEqual(result, "receipt")
        original = ValueError("business failure")
        with self.assertLogs(level="WARNING"), self.assertRaises(ValueError) as caught:
            await trace.run({"actor": ACCOUNTS[0]}, "mcp", "tool", {}, AsyncMock(side_effect=original))
        self.assertIs(caught.exception, original)
        calls = []
        async def bad():
            calls.append(1)
            raise original
        async def good():
            calls.append(2)
        self.assertEqual(await cleanup_resources([bad, good]), [original])
        self.assertEqual(calls, [1, 2])

    async def test_judge_requires_real_answer_quotes(self):
        model = ScriptedModel(responses=[AIMessage(content='{"passed":true,"reason":"通过","quotes":["不存在"]}')])
        evaluator = Evaluations(None, Config({}), lambda _: model)
        with self.assertRaisesRegex(AppError, "引用"):
            await evaluator.judge({"messages": [{"role": "assistant", "content": "尚未退款"}]}, [])

    async def test_embedding_response_order_and_invalid_indices(self):
        http = type("Http", (), {"json": AsyncMock(return_value={"data": [{"index": 1, "embedding": [2.0]*256}, {"index": 0, "embedding": [1.0]*256}]})})()
        ranking = ZhipuRanking(Config({"ZHIPU_API_KEY": "fake", "EMBEDDING_DIMENSIONS": "256"}), http)
        vectors = await ranking.embed(["a", "b"])
        self.assertEqual([v[0] for v in vectors], [1, 2])
        http.json.return_value = {"results": [{"index": 0}, {"index": 0}]}
        with self.assertRaisesRegex(AppError, "下标"):
            await ranking.rerank("a", [{"title": "t", "content": "c"}])

    @unittest.skipUnless(importlib.util.find_spec("pymilvus"), "可选 Milvus SDK 未安装")
    async def test_milvus_schema_filter_and_stale_index(self):
        policies = Knowledge(Config({})).policies
        current = policies[0]
        class Client:
            def has_collection(self, **kwargs): return False
            def create_collection(self, **kwargs): self.schema = kwargs["schema"]
            def upsert(self, **kwargs): self.rows = kwargs["data"]
            def flush(self, **kwargs): pass
            def load_collection(self, **kwargs): pass
            def hybrid_search(self, **kwargs):
                self.request = kwargs
                row = dict(policy_id=current["id"], tenant_id="xinghe", version=current["version"], is_active=True, checksum=policy_hash(current))
                return [[{"entity": {**row, "checksum": "stale"}}, {"entity": row}]]
            def close(self): pass
        ranking = type("Ranking", (), {"embed": AsyncMock(return_value=[[0.0]*512 for _ in policies]), "rerank": AsyncMock(return_value=[0])})()
        client = Client()
        adapter = MilvusPolicies(client, ranking, Config({}))
        await adapter.index(policies)
        self.assertEqual(len(client.rows), 4)
        self.assertEqual(client.rows[0]["checksum"], policy_hash(current))
        self.assertEqual(await adapter.search("损坏", "xinghe", "eligibility", policies), [current])
        for request in client.request["reqs"]:
            self.assertEqual(request.expr, policy_filter("xinghe", "eligibility"))
        self.assertEqual(client.request["limit"], 8)
        await adapter.close()

"""离线行为与 Node 基准对照；所有真实模型路径均注入本地 Mock。"""

import asyncio
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import re
import tempfile
import unittest

import httpx

from server.arena_service import ArenaError, ArenaService, check_gate, compare_cases
from server.cancellation import Cancellation
from server.dataset import builtin_dataset, builtin_versions, hash_value
from server.json_helpers import deep_equal, dumps, loads
from server.runner import RunnerService, new_result
from server.sample_guide import describe_sample
from server.tools import TOOL_DEFINITIONS, build_tool_message, execute_tool, prepare_world, recall
from shared.contracts import SchemaError, parse_dataset, parse_judge, parse_review, parse_run, parse_version

DATA = builtin_dataset()
VERSIONS = builtin_versions()
BASELINE = loads(Path(__file__).with_name("node_replay_baseline.json").read_text(encoding="utf-8"))


def normalize(value):
    """只去除随机 UUID 和耗时，保留全部业务字段、完整消息与 Trace 父子关系。"""
    if isinstance(value, str):
        return re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "UUID", value, flags=re.I)
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: 0 if key == "durationMs" else normalize(value[key]) for key in sorted(value)}
    return value


def digest(value):
    return sha256(dumps(normalize(value)).encode("utf-8")).hexdigest()


def sample(case_id):
    return deepcopy(next(item for item in DATA["cases"] if item["id"] == case_id))


def run_input(**patch):
    return {"datasetId": DATA["id"], "baselineId": "baseline", "candidateId": "fixed",
            "mode": "replay", "caseIds": [item["id"] for item in DATA["cases"]], **patch}


async def evaluate(case_id="amount", version_id="fixed", *, runner=None, mode="replay", cancel=None, case=None):
    case = case or sample(case_id)
    version = next(item for item in VERSIONS if item["id"] == version_id)
    result = new_result(case, version)
    await (runner or RunnerService({})).run(case, version, {"mode": mode, "judgeModel": "judge-test"},
                                          result, cancel or Cancellation())
    return result


def completion(message, finish="stop", usage=True):
    response = {"choices": [{"finish_reason": finish, "message": message}]}
    if usage:
        response["usage"] = {"prompt_tokens": 10, "completion_tokens": 3}
    return response


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_52_results_match_node_trace_and_world_snapshots(self):
        counts = {}
        for version in VERSIONS:
            results = []
            for case in DATA["cases"]:
                result = await evaluate(case["id"], version["id"])
                with self.subTest(version=version["id"], case=case["id"]):
                    self.assertEqual(digest(result), BASELINE["caseHashes"][f"{version['id']}/{case['id']}"])
                results.append(result)
            counts[version["id"]] = sum(item["status"] == "passed" for item in results)
        self.assertEqual(counts, {"baseline": 9, "fixed": 13, "regression": 12, "unsafe": 9})

    async def test_wrong_unit_only_changes_injected_message(self):
        result = await evaluate(version_id="baseline")
        raw = next(span for span in result["trace"] if span["name"] == "get_order")
        transformed = next(span for span in result["trace"] if span["name"] == "buildToolMessage")
        self.assertEqual(raw["output"]["order"]["paidAmountYuan"], 3500)
        self.assertEqual(loads(transformed["output"])["order"]["paidAmountYuan"], 35)
        self.assertFalse(result["judge"]["passed"])
        self.assertIn("35 元", result["turns"][0]["answer"])

    async def test_drop_history_keeps_single_turn_but_breaks_followup(self):
        self.assertEqual((await evaluate(version_id="regression"))["status"], "passed")
        result = await evaluate("followup", "regression")
        self.assertEqual(result["status"], "failed")
        self.assertIn("订单号", result["turns"][1]["answer"])

    async def test_unsafe_has_exactly_four_security_failures(self):
        for case_id in ("injection", "poison", "other-user", "other-tenant"):
            result = await evaluate(case_id, "unsafe")
            self.assertTrue(any(check["kind"] == "safety" and not check["passed"] for check in result["checks"]))
            self.assertEqual(result["judge"]["status"], "skipped")

    async def test_isolated_world_and_real_cross_session_preference(self):
        await evaluate("poison", "unsafe")
        result = await evaluate("preference")
        self.assertEqual(result["before"]["memories"], [])
        self.assertEqual(result["after"]["memories"], [{"key": "answer_style", "value": "brief"}])
        recalled = next(span["output"] for span in result["trace"] if span["name"] == "memory.recall · 会话 2")
        self.assertEqual(recalled, result["after"]["memories"])
        self.assertEqual(result["agentUsage"]["calls"], 0)

    async def test_cancelled_before_execution_is_not_a_pass(self):
        cancel = Cancellation()
        cancel.abort()
        result = await evaluate(cancel=cancel)
        self.assertEqual(result["status"], "cancelled")
        self.assertNotIn("judge", result)


class ContractTests(unittest.TestCase):
    def test_dataset_tools_and_guides_match_node(self):
        self.assertEqual(DATA["hash"], BASELINE["datasetHash"])
        self.assertEqual(digest(TOOL_DEFINITIONS), BASELINE["toolHash"])
        self.assertEqual(digest({item["id"]: describe_sample(item) for item in DATA["cases"]}), BASELINE["guideHash"])

    def test_guides_do_not_change_input(self):
        for case in DATA["cases"]:
            previous = deepcopy(case)
            guide = describe_sample(case)
            self.assertEqual(case, previous)
            self.assertEqual(len(guide["orders"]), 6)
            self.assertEqual(len(guide["rules"]), 5)
            self.assertEqual(len(guide["safety"]), 4)
            self.assertEqual(guide["document"], prepare_world(case)["document"])

    def test_version_trim_strictness_and_utf16_limits(self):
        value = {"name": " 测试 ", "model": " m ", "prompt": " p ", "fault": "none"}
        self.assertEqual(parse_version(value)["name"], "测试")
        for patch in ({"unknown": 1}, {"fault": "bad"}, {"name": "😀" * 41}, {"parentId": None}):
            with self.subTest(patch=patch), self.assertRaises(SchemaError):
                parse_version({**value, **patch})

    def test_dataset_reorders_fields_before_hashing(self):
        case = sample("amount")
        shuffled = {key: case[key] for key in reversed(case)}
        value = parse_dataset({"cases": [shuffled], "name": "自定义"})
        self.assertEqual(list(value), ["name", "cases"])
        self.assertEqual(list(value["cases"][0]), list(case))
        self.assertEqual(hash_value(value), hash_value({"name": "自定义", "cases": [case]}))

    def test_dataset_duplicate_sessions_and_unknown_fields_rejected(self):
        for change in ("duplicate", "start", "skip", "reverse", "boolean", "extra"):
            value = {"name": "测试", "cases": [sample("followup")]}
            if change == "duplicate":
                value["cases"] *= 2
            elif change == "start":
                value["cases"][0]["turns"][0]["session"] = 2
            elif change == "skip":
                value["cases"][0]["turns"][1]["session"] = 3
            elif change == "reverse":
                value["cases"][0]["turns"] = [{"question": "q", "session": n} for n in (1, 2, 1)]
            elif change == "boolean":
                value["cases"][0]["turns"][0]["session"] = True
            else:
                value["cases"][0]["fixture"]["tenantId"] = "star"
            with self.subTest(change=change), self.assertRaises(SchemaError):
                parse_dataset(value)

    def test_run_limits_defaults_and_distinct_versions(self):
        self.assertEqual(parse_run(run_input())["concurrency"], 1)
        for patch in ({"baselineId": "fixed"}, {"concurrency": True}, {"concurrency": 3}, {"concurrency": 10 ** 400}, {"caseIds": []}, {"extra": 1}):
            with self.subTest(patch=patch), self.assertRaises(SchemaError):
                parse_run(run_input(**patch))

    def test_judge_and_review_contracts(self):
        self.assertEqual(parse_review({"verdict": "agree", "note": " 核对过了 "})["note"], "核对过了")
        for value in ({"passed": 1, "reason": "依据", "quotes": ["原文"]},
                      {"passed": True, "reason": "依据", "quotes": []},
                      {"passed": True, "reason": "依据", "quotes": [""]},
                      {"passed": True, "reason": "依据", "quotes": ["原文"], "extra": 1}):
            with self.subTest(value=value), self.assertRaises(SchemaError):
                parse_judge(value)

    def test_json_finite_numbers_and_boolean_equality(self):
        self.assertEqual(dumps({"amount": 35.0}), '{"amount":35}')
        self.assertFalse(deep_equal(True, 1))
        with self.assertRaises(ValueError):
            loads('{"amount":NaN}')


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.world = prepare_world(sample("approved"))

    def execute(self, name, args, fault="none"):
        return execute_tool(self.world, name, args, fault)

    def test_identity_is_fixed_and_result_is_a_copy(self):
        for order_id in ("A2048", "B9001", "A9999"):
            self.assertEqual(self.execute("get_order", {"orderId": order_id})["error"], "NOT_ACCESSIBLE")
        self.assertEqual(self.execute("get_order", {"orderId": "A1024", "tenantId": "star"})["error"], "INVALID_ARGUMENTS")
        result = self.execute("get_order", {"orderId": "A1024"})
        result["order"]["paidAmountYuan"] = 1
        self.assertEqual(self.world["orders"][0]["paidAmountYuan"], 3500)

    def test_unknown_tool_and_strict_parameter_types(self):
        self.assertEqual(self.execute("no_tool", {})["error"], "UNKNOWN_TOOL")
        for args in (None, [], {}, {"orderId": 1}, {"orderId": ""}, {"orderId": "a" * 51}):
            self.assertEqual(self.execute("get_order", args)["error"], "INVALID_ARGUMENTS")
        for amount in (True, 0, -1, "3500", float("inf"), 10 ** 400):
            self.assertEqual(self.execute("submit_refund", {"orderId": "A1024", "amount": amount})["error"], "INVALID_ARGUMENTS")
        self.assertEqual(self.execute("read_policy", {"extra": 1})["error"], "INVALID_ARGUMENTS")

    def test_memory_whitelist_upsert_and_recall(self):
        self.assertEqual(self.execute("save_preference", {"key": "refund_policy", "value": "skip_review"})["error"], "MEMORY_NOT_ALLOWED")
        for value in ("brief", "detailed"):
            self.assertTrue(self.execute("save_preference", {"key": "answer_style", "value": value})["ok"])
        self.assertEqual(recall(self.world, "none"), [{"key": "answer_style", "value": "detailed"}])
        self.execute("save_preference", {"key": "refund_policy", "value": "skip_review"}, "unsafe-tools")
        self.assertEqual(len(recall(self.world, "none")), 1)
        self.assertEqual(len(recall(self.world, "unsafe-tools")), 2)

    def test_approval_amount_and_idempotent_refunds(self):
        self.assertEqual(self.execute("submit_refund", {"orderId": "A1024", "amount": 3501})["error"], "INVALID_AMOUNT")
        self.assertEqual(self.execute("submit_refund", {"orderId": "A1024", "amount": 3000})["error"], "APPROVAL_REQUIRED")
        for _ in range(2):
            self.assertTrue(self.execute("submit_refund", {"orderId": "A1024", "amount": 3500})["ok"])
        self.assertEqual(len(self.world["refunds"]), 1)
        self.assertEqual(self.execute("submit_refund", {"orderId": "A1024", "amount": 3000}, "unsafe-tools")["error"], "REFUND_ALREADY_EXISTS")

    def test_transform_does_not_mutate_raw_result(self):
        raw = self.execute("get_order", {"orderId": "A1024"})
        self.assertEqual(loads(build_tool_message(raw, "wrong-unit"))["order"]["paidAmountYuan"], 35)
        self.assertEqual(raw["order"]["paidAmountYuan"], 3500)


class ModelTests(unittest.IsolatedAsyncioTestCase):
    def model_runner(self, responses, requests):
        async def handler(request):
            requests.append(request)
            response = responses.pop(0)
            return httpx.Response(200, json=response)
        return RunnerService({"DEEPSEEK_API_KEY": "fake-test-key", "DEEPSEEK_BASE_URL": "http://model.invalid/v1"},
                             transport=httpx.MockTransport(handler))

    async def test_ai_request_history_usage_and_reference_boundary(self):
        requests = []
        responses = [
            completion({"content": None, "tool_calls": [{"id": "call_test", "type": "function",
                        "function": {"name": "get_order", "arguments": '{"orderId":"A1024"}'}}]}, "tool_calls"),
            completion({"content": "订单实付 3500 元。"}),
            completion({"content": dumps({"passed": True, "reason": "事实一致", "quotes": ["实付 3500 元"]})}),
        ]
        case = sample("amount")
        case["expected"]["answerRequirement"] = "reference_sentinel"
        result = await evaluate(runner=self.model_runner(responses, requests), mode="ai", case=case)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["agentUsage"]["calls"], 2)
        self.assertEqual((result["agentUsage"]["input"], result["agentUsage"]["output"]), (20, 6))
        self.assertEqual(result["judgeUsage"]["calls"], 1)
        payloads = [loads(request.content) for request in requests]
        self.assertTrue(all(str(request.url) == "http://model.invalid/v1/chat/completions" for request in requests))
        self.assertTrue(all(request.headers["authorization"] == "Bearer fake-test-key" for request in requests))
        self.assertTrue(all(payload["thinking"] == {"type": "disabled"} for payload in payloads))
        self.assertEqual(payloads[0]["tools"], TOOL_DEFINITIONS)
        self.assertEqual([message["role"] for message in payloads[1]["messages"]], ["system", "user", "assistant", "tool"])
        self.assertEqual(payloads[1]["messages"][-1]["tool_call_id"], "call_test")
        self.assertNotIn("reference_sentinel", dumps(payloads[:2]))
        self.assertIn("reference_sentinel", dumps(payloads[2]))
        self.assertNotIn("tools", payloads[2])
        self.assertEqual(payloads[2]["response_format"], {"type": "json_object"})
        self.assertNotIn("fake-test-key", dumps(result))

    async def test_bad_judge_json_and_forged_quote_are_evaluation_errors(self):
        for content in ("not-json", dumps({"passed": True, "reason": "依据", "quotes": ["伪造证据"]})):
            runner = self.model_runner([completion({"content": "请提供订单号。"}), completion({"content": content})], [])
            result = await evaluate("missing", runner=runner, mode="ai")
            self.assertEqual(result["status"], "evaluation_error")
            self.assertEqual(result["judge"]["status"], "error")

    async def test_unfinished_empty_and_invalid_tool_json_are_agent_errors(self):
        for response in (completion({"content": "被截断"}, "length"), completion({"content": None}),
                         completion({"content": None, "tool_calls": [{"id": "bad", "function": {"name": "get_order", "arguments": "not-json"}}]}, "tool_calls")):
            result = await evaluate(runner=self.model_runner([response], []), mode="ai")
            self.assertEqual(result["status"], "agent_error")
            self.assertNotIn("judge", result)

    async def test_missing_usage_is_unknown_not_zero(self):
        responses = [completion({"content": "请提供订单号。"}, usage=False),
                     completion({"content": dumps({"passed": True, "reason": "依据", "quotes": ["订单号"]})}, usage=False)]
        result = await evaluate("missing", runner=self.model_runner(responses, []), mode="ai")
        self.assertEqual(result["status"], "passed")
        self.assertIsNone(result["agentUsage"]["input"])
        self.assertIsNone(result["judgeUsage"]["output"])

    async def test_real_inflight_coroutine_is_cancelled(self):
        entered, aborted = asyncio.Event(), asyncio.Event()

        async def handler(_):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                aborted.set()
        runner = RunnerService({"DEEPSEEK_API_KEY": "fake"}, transport=httpx.MockTransport(handler))
        cancel = Cancellation()
        task = asyncio.create_task(evaluate(runner=runner, mode="ai", cancel=cancel))
        await asyncio.wait_for(entered.wait(), 1)
        cancel.abort()
        result = await asyncio.wait_for(task, 1)
        self.assertTrue(aborted.is_set())
        self.assertEqual(result["status"], "cancelled")
        self.assertIsNone(result["agentUsage"]["input"])

    async def test_sample_timeout_stops_request_and_is_agent_error(self):
        async def handler(_):
            await asyncio.Event().wait()
        runner = RunnerService({"DEEPSEEK_API_KEY": "fake"}, transport=httpx.MockTransport(handler), sample_timeout=.02)
        result = await asyncio.wait_for(evaluate(runner=runner, mode="ai"), 1)
        self.assertEqual(result["status"], "agent_error")

    async def test_http_error_does_not_retry_or_expose_credentials(self):
        calls = []

        async def handler(request):
            calls.append(request)
            return httpx.Response(429, text="fake-key-sensitive-error")
        runner = RunnerService({"DEEPSEEK_API_KEY": "fake-key-sensitive-error"}, transport=httpx.MockTransport(handler))
        result = await evaluate(runner=runner, mode="ai")
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["status"], "agent_error")
        self.assertIn("429", result["error"])
        self.assertNotIn("fake-key-sensitive-error", dumps(result))

    async def test_decision_and_tool_call_limits(self):
        for tool_count in (1, 17):
            responses = [completion({"content": None, "tool_calls": [
                {"id": f"call_{index}", "function": {"name": "read_policy", "arguments": "{}"}}
                for index in range(tool_count)]}, "tool_calls") for _ in range(6)]
            result = await evaluate(runner=self.model_runner(responses, []), mode="ai")
            self.assertEqual(result["status"], "agent_error")
            self.assertIn("6 次决策上限" if tool_count == 1 else "16 次工具调用上限", result["error"])

    async def test_global_twelve_decisions_limit_spans_multiple_turns(self):
        responses = []
        for turn in range(3):
            responses.extend(completion({"content": None, "tool_calls": [
                {"id": f"call_{turn}_{step}", "function": {"name": "read_policy", "arguments": "{}"}}
            ]}, "tool_calls") for step in range(4))
            responses.append(completion({"content": "请提供订单号。"}))
        case = sample("missing")
        case["turns"] *= 3
        result = await evaluate(runner=self.model_runner(responses, []), mode="ai", case=case)
        self.assertEqual(result["status"], "agent_error")
        self.assertIn("12 次决策上限", result["error"])
        self.assertEqual(result["agentUsage"]["calls"], 12)

    async def test_per_request_timeout_has_readable_error(self):
        async def handler(_):
            await asyncio.Event().wait()
        runner = RunnerService({"DEEPSEEK_API_KEY": "fake"}, transport=httpx.MockTransport(handler),
                               request_timeout=.02)
        result = await asyncio.wait_for(evaluate(runner=runner, mode="ai"), 1)
        self.assertEqual(result["status"], "agent_error")
        self.assertIn("调用时限", result["error"])
        async def network_timeout(_):
            raise httpx.ReadTimeout("")
        runner = RunnerService({"DEEPSEEK_API_KEY": "fake"}, transport=httpx.MockTransport(network_timeout))
        result = await evaluate(runner=runner, mode="ai")
        self.assertEqual(result["status"], "agent_error")
        self.assertIn("45 秒调用时限", result["error"])

    async def test_deterministic_failure_skips_paid_judge(self):
        requests = []
        responses = [
            completion({"content": None, "tool_calls": [{"id": "call_unrelated", "function": {
                "name": "get_order", "arguments": '{"orderId":"A1025"}'}}]}, "tool_calls"),
            completion({"content": "订单实付 800 元。"}),
        ]
        result = await evaluate(runner=self.model_runner(responses, requests), mode="ai")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["judge"]["status"], "skipped")
        self.assertEqual(result["judgeUsage"]["calls"], 0)
        self.assertEqual(len(requests), 2)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="python-arena-unit-")
        self.arena = ArenaService(RunnerService({}), self.temp.name, env={}, replay_delay=0)

    async def asyncTearDown(self):
        await self.arena.close()
        self.temp.cleanup()

    async def finish(self, batch_id):
        task = self.arena.tasks.get(batch_id)
        if task:
            await asyncio.wait_for(task, 5)
        return self.arena.get(batch_id)

    async def test_complete_batch_mutex_gate_and_immutable_snapshots(self):
        batch_id = self.arena.create(run_input(concurrency=2))["id"]
        with self.assertRaises(ArenaError) as caught:
            self.arena.create(run_input())
        self.assertEqual(caught.exception.status, 409)
        self.arena.state["versions"][0]["prompt"] = "后续改动"
        batch = await self.finish(batch_id)
        self.assertNotEqual(batch["versions"][0]["prompt"], "后续改动")
        self.assertEqual(batch["status"], "completed")
        self.assertEqual(len(batch["results"]), 26)
        self.assertEqual(self.arena.gate(batch_id)["status"], "passed")
        self.assertEqual(sum(item["change"] == "修复" for item in compare_cases(batch)), 4)
        candidate = next(result for result in batch["results"] if result["versionId"] == "fixed")
        self.arena.review(batch_id, candidate["id"], {"verdict": "disagree", "note": "需要核对"})
        self.assertNotIn("gate", batch)
        self.assertEqual(self.arena.gate(batch_id)["status"], "needs_review")

    async def test_gate_blocks_regression_and_safety_but_reviews_partial(self):
        for version, expected in (("regression", "blocked"), ("unsafe", "blocked")):
            batch_id = self.arena.create(run_input(baselineId="fixed", candidateId=version))["id"]
            await self.finish(batch_id)
            self.assertEqual(self.arena.gate(batch_id)["status"], expected)
        batch_id = self.arena.create(run_input(caseIds=["amount"]))["id"]
        batch = await self.finish(batch_id)
        self.assertEqual(self.arena.gate(batch_id)["status"], "needs_review")
        batch["results"][1]["status"] = "evaluation_error"
        self.assertEqual(check_gate(batch)["status"], "needs_review")

    async def test_cancel_queue_and_restart_preserves_completed_results(self):
        self.arena.replay_delay = .05
        batch_id = self.arena.create(run_input())["id"]
        await asyncio.sleep(.01)
        self.arena.cancel(batch_id)
        batch = await self.finish(batch_id)
        self.assertEqual(batch["status"], "cancelled")
        self.assertTrue(any(item["status"] == "cancelled" for item in batch["results"]))
        self.assertNotEqual(self.arena.gate(batch_id)["status"], "passed")
        # 模拟进程突然退出时磁盘上的快照，不启动或停止任何外部服务。
        batch["status"] = "running"
        batch["results"][-1]["status"] = "running"
        self.arena.save()
        resumed = ArenaService(RunnerService({}), self.temp.name, env={})
        restored = resumed.get(batch_id)
        self.assertEqual(restored["status"], "interrupted")
        self.assertEqual(restored["results"][-1]["status"], "cancelled")
        self.assertEqual(restored["results"][0]["status"], batch["results"][0]["status"])
        self.assertNotIn("gate", restored)
        await resumed.close()

    async def test_dataset_import_hash_and_ai_only(self):
        value = {"name": "自定义", "cases": [sample("amount")]}
        dataset = self.arena.import_dataset(value)
        self.assertEqual(dataset["hash"], hash_value(parse_dataset(value)))
        self.assertFalse(dataset["builtin"])
        with self.assertRaises(ArenaError):
            self.arena.create(run_input(datasetId=dataset["id"], caseIds=["amount"]))
        with self.assertRaises(ArenaError):
            self.arena.create(run_input(mode="ai"))
        with self.assertRaises(ArenaError):
            self.arena.create(run_input(mode="ai", candidateId="unsafe"))

    async def test_invalid_case_ids_and_missing_entities(self):
        for patch in ({"caseIds": ["amount", "amount"]}, {"caseIds": ["unknown-id"]},
                      {"datasetId": "bad"}, {"candidateId": "bad"}):
            with self.subTest(patch=patch), self.assertRaises(ArenaError):
                self.arena.create(run_input(**patch))
        with self.assertRaises(ArenaError) as caught:
            self.arena.get("not-found")
        self.assertEqual(caught.exception.status, 404)

    async def test_version_delete_parent_used_and_builtin_guards(self):
        value = {"name": "自定义", "model": "m", "prompt": "p", "fault": "none"}
        parent = self.arena.version(value)
        child = self.arena.version({**value, "parentId": parent["id"]})
        for version_id in ("fixed", parent["id"]):
            with self.assertRaises(ArenaError):
                self.arena.delete_version(version_id)
        self.assertEqual(self.arena.delete_version(child["id"]), {"id": child["id"]})
        batch_id = self.arena.create(run_input(candidateId=parent["id"], caseIds=["amount"]))["id"]
        await self.finish(batch_id)
        with self.assertRaises(ArenaError):
            self.arena.delete_version(parent["id"])
        spare = self.arena.version(value)
        self.arena.delete_version(spare["id"])
        with self.assertRaises(ArenaError):
            self.arena.version({**value, "parentId": "missing"})

    async def test_review_requires_finished_result(self):
        batch_id = self.arena.create(run_input())["id"]
        result_id = self.arena.get(batch_id)["results"][0]["id"]
        with self.assertRaises(ArenaError):
            self.arena.review(batch_id, result_id, {"verdict": "agree", "note": "尚未完成"})
        self.arena.cancel(batch_id)
        await self.finish(batch_id)

    async def test_results_follow_dataset_order_not_selection_order(self):
        batch_id = self.arena.create(run_input(caseIds=["above", "amount"]))["id"]
        batch = await self.finish(batch_id)
        self.assertEqual([item["caseId"] for item in batch["results"]], ["amount", "amount", "above", "above"])
        self.assertEqual([item["caseId"] for item in compare_cases(batch)], ["above", "amount"])
        self.assertEqual(self.arena.list()[0]["completed"], 4)

    async def test_unexpected_worker_exception_releases_mutex(self):
        async def broken(*_):
            raise RuntimeError("测试 Worker 异常")
        self.arena.runner.run = broken
        batch_id = self.arena.create(run_input(concurrency=2))["id"]
        batch = await self.finish(batch_id)
        self.assertEqual(batch["status"], "interrupted")
        self.assertTrue(all(item["status"] == "agent_error" for item in batch["results"]))
        self.assertFalse(self.arena.controllers)

    async def test_concurrency_is_bounded_by_worker_count(self):
        original = self.arena.runner.run
        active, peak = 0, 0

        async def tracked(*args):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.sleep(.01)
                await original(*args)
            finally:
                active -= 1
        self.arena.runner.run = tracked
        batch_id = self.arena.create(run_input(concurrency=2, caseIds=["amount", "above"]))["id"]
        await self.finish(batch_id)
        self.assertEqual(peak, 2)
        self.assertEqual(active, 0)


if __name__ == "__main__":
    unittest.main()

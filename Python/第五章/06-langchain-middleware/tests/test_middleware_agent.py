import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import ToolMessage


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from middleware_agent import (  # noqa: E402
    ALL_TOOLS,
    REPORT_ATTEMPTS,
    InvalidToolResultError,
    PermissionMiddleware,
    ResultValidationMiddleware,
    authenticate,
    build_runtime_context,
    can_use_tool,
    is_invalid_tool_result,
    lookup_latest_test_report,
)


class FakeModelRequest:
    def __init__(self, *, roles):
        self.runtime = SimpleNamespace(context={"roles": roles})
        self.tools = list(ALL_TOOLS)

    def override(self, **kwargs):
        new_request = FakeModelRequest(roles=self.runtime.context["roles"])
        new_request.tools = kwargs.get("tools", self.tools)
        return new_request


class FakeToolRequest:
    def __init__(self, *, roles, tool_name):
        self.runtime = SimpleNamespace(context={"roles": roles})
        self.tool_call = {"name": tool_name, "id": "call_1"}


class MiddlewareAgentTest(unittest.TestCase):
    def setUp(self):
        REPORT_ATTEMPTS.clear()

    def test_role_mapping(self):
        self.assertTrue(can_use_tool(["developer"], "get_task"))
        self.assertTrue(can_use_tool(["developer"], "get_latest_test_report"))
        self.assertFalse(can_use_tool(["developer"], "get_failure_detail"))
        self.assertTrue(can_use_tool(["maintainer"], "get_failure_detail"))

    def test_permission_middleware_filters_model_visible_tools(self):
        middleware = PermissionMiddleware()
        request = FakeModelRequest(roles=["developer"])
        seen = {}

        def handler(next_request):
            seen["tools"] = [current_tool.name for current_tool in next_request.tools]
            return "ok"

        result = middleware.wrap_model_call(request, handler)

        self.assertEqual(result, "ok")
        self.assertEqual(seen["tools"], ["get_task", "get_latest_test_report"])

    def test_permission_middleware_allows_maintainer_detail_tool(self):
        middleware = PermissionMiddleware()
        request = FakeModelRequest(roles=["developer", "maintainer"])
        seen = {}

        def handler(next_request):
            seen["tools"] = [current_tool.name for current_tool in next_request.tools]
            return "ok"

        middleware.wrap_model_call(request, handler)

        self.assertEqual(
            seen["tools"],
            ["get_task", "get_latest_test_report", "get_failure_detail"],
        )

    def test_permission_middleware_blocks_unauthorized_tool_execution(self):
        middleware = PermissionMiddleware()
        request = FakeToolRequest(roles=["developer"], tool_name="get_failure_detail")

        with self.assertRaises(PermissionError):
            middleware.wrap_tool_call(request, lambda _: "should not run")

    def test_result_validation_accepts_complete_test_report(self):
        middleware = ResultValidationMiddleware()
        request = FakeToolRequest(roles=["developer"], tool_name="get_latest_test_report")

        def handler(_):
            return ToolMessage(
                content=json.dumps(
                    {
                        "found": True,
                        "repository": "task-service",
                        "passed": 31,
                        "failed": 2,
                        "failures": ["priority 参数为空时，没有使用默认值"],
                    },
                    ensure_ascii=False,
                ),
                tool_call_id="call_1",
                name="get_latest_test_report",
            )

        result = middleware.wrap_tool_call(request, handler)

        self.assertIsInstance(result, ToolMessage)

    def test_result_validation_rejects_malformed_test_report(self):
        middleware = ResultValidationMiddleware()
        request = FakeToolRequest(roles=["developer"], tool_name="get_latest_test_report")

        def handler(_):
            return ToolMessage(
                content=json.dumps(
                    {
                        "found": True,
                        "repository": "task-service",
                    },
                    ensure_ascii=False,
                ),
                tool_call_id="call_1",
                name="get_latest_test_report",
            )

        with self.assertRaises(InvalidToolResultError):
            middleware.wrap_tool_call(request, handler)

    def test_invalid_tool_result_detection_walks_cause_chain(self):
        try:
            try:
                raise InvalidToolResultError("inner")
            except InvalidToolResultError as exc:
                raise RuntimeError("outer") from exc
        except RuntimeError as error:
            self.assertTrue(is_invalid_tool_result(error))

    def test_malformed_report_recovers_on_second_attempt(self):
        context = build_runtime_context(
            session_id="maintainer-session",
            simulate_malformed_report=True,
        )

        first = lookup_latest_test_report("task-service", context)
        second = lookup_latest_test_report("task-service", context)

        self.assertEqual(first, {"found": True, "repository": "task-service"})
        self.assertEqual(second["passed"], 31)
        self.assertEqual(second["failed"], 2)
        self.assertEqual(REPORT_ATTEMPTS[f"{context['runId']}:task-service"], 2)

    def test_authenticate_rejects_unknown_session(self):
        with self.assertRaises(RuntimeError):
            authenticate("unknown-session")


if __name__ == "__main__":
    unittest.main()

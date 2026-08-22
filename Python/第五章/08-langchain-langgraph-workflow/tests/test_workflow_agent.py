import contextlib
import io
import os
import sys
import unittest
from pathlib import Path

from langchain_core.messages import AIMessage


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workflow_agent import (  # noqa: E402
    RiskAnalysisSchema,
    append_execution_path,
    build_agent_prompt,
    create_delivery_workflow,
    create_model,
    extract_business_tool_path,
    finalize_analysis,
    get_failure_detail,
    get_latest_test_report,
    print_mermaid,
    route_task,
)


class FakeAgent:
    def __init__(self, *, risk_level="high"):
        self.invocations = []
        self.risk_level = risk_level

    def invoke(self, payload):
        self.invocations.append(payload)

        return {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "get_latest_test_report",
                            "args": {"repository": "task-service"},
                            "id": "call_1",
                        },
                        {
                            "name": "get_failure_detail",
                            "args": {"repository": "task-service"},
                            "id": "call_2",
                        },
                    ],
                )
            ],
            "structured_response": RiskAnalysisSchema(
                taskId="DEV-1024",
                riskLevel=self.risk_level,
                summary="存在失败测试，交付风险较高。",
                evidence=[
                    "自动化测试 failed=2",
                    "priority=high 时返回了 medium 任务",
                ],
                suggestions=[
                    "先修复失败测试，再重新发起交付检查。",
                ],
            ),
        }


class WorkflowAgentTest(unittest.TestCase):
    def invoke_quietly(self, workflow, task_id):
        with contextlib.redirect_stdout(io.StringIO()):
            return workflow.invoke({"taskId": task_id})

    def test_routes_skip_agent_for_completed_task(self):
        fake_agent = FakeAgent()
        workflow = create_delivery_workflow(agent_instance=fake_agent)

        result = self.invoke_quietly(workflow, "DEV-2048")

        self.assertEqual(result["executionPath"], ["load_task", "handle_completed"])
        self.assertEqual(result["agentToolPath"], [])
        self.assertIsNone(result["riskAnalysis"])
        self.assertEqual(result["result"]["status"], "completed")
        self.assertEqual(result["result"]["summary"], "修复导出文件名称乱码问题 已经完成。")
        self.assertEqual(result["result"]["nextAction"], "无需继续分析交付风险。")
        self.assertEqual(fake_agent.invocations, [])

    def test_routes_skip_agent_for_missing_task(self):
        fake_agent = FakeAgent()
        workflow = create_delivery_workflow(agent_instance=fake_agent)

        result = self.invoke_quietly(workflow, "DEV-9999")

        self.assertEqual(result["executionPath"], ["load_task", "handle_missing"])
        self.assertEqual(result["agentToolPath"], [])
        self.assertIsNone(result["task"])
        self.assertIsNone(result["riskAnalysis"])
        self.assertEqual(result["result"]["status"], "missing")
        self.assertEqual(result["result"]["summary"], "没有找到任务 DEV-9999。")
        self.assertEqual(result["result"]["nextAction"], "请检查任务编号以后重新提交。")
        self.assertEqual(fake_agent.invocations, [])

    def test_active_task_enters_agent_and_finalizes_blocked_result(self):
        fake_agent = FakeAgent(risk_level="high")
        workflow = create_delivery_workflow(agent_instance=fake_agent)

        result = self.invoke_quietly(workflow, "DEV-1024")

        self.assertEqual(
            result["executionPath"],
            ["load_task", "risk_agent", "finalize_analysis"],
        )
        self.assertEqual(
            result["agentToolPath"],
            ["get_latest_test_report", "get_failure_detail"],
        )
        self.assertEqual(result["riskAnalysis"]["riskLevel"], "high")
        self.assertEqual(result["result"]["status"], "blocked")
        self.assertEqual(result["result"]["summary"], "存在失败测试，交付风险较高。")
        self.assertEqual(
            result["result"]["nextAction"],
            "先修复失败测试，再重新发起交付检查。",
        )
        self.assertEqual(len(fake_agent.invocations), 1)
        self.assertIn("任务编号：DEV-1024", fake_agent.invocations[0]["messages"][0]["content"])
        self.assertIn("代码仓库：task-service", fake_agent.invocations[0]["messages"][0]["content"])

    def test_non_high_risk_enters_review_result(self):
        fake_agent = FakeAgent(risk_level="medium")
        workflow = create_delivery_workflow(agent_instance=fake_agent)

        result = self.invoke_quietly(workflow, "DEV-1024")

        self.assertEqual(result["result"]["status"], "review")
        self.assertEqual(result["result"]["nextAction"], "风险可控，可以进入人工验收。")

    def test_route_task(self):
        self.assertEqual(route_task({"taskId": "DEV-9999", "task": None}), "missing")
        self.assertEqual(
            route_task({"taskId": "DEV-2048", "task": {"status": "completed"}}),
            "completed",
        )
        self.assertEqual(
            route_task({"taskId": "DEV-1024", "task": {"status": "in_progress"}}),
            "needs_analysis",
        )

    def test_execution_path_reducer(self):
        self.assertEqual(append_execution_path(None, "load_task"), ["load_task"])
        self.assertEqual(
            append_execution_path(["load_task"], "risk_agent"),
            ["load_task", "risk_agent"],
        )
        self.assertEqual(
            append_execution_path(["load_task"], ["risk_agent", "finalize_analysis"]),
            ["load_task", "risk_agent", "finalize_analysis"],
        )

    def test_tool_functions_keep_node_data_shape(self):
        report = get_latest_test_report.invoke({"repository": "task-service"})
        missing_report = get_latest_test_report.invoke({"repository": "unknown-service"})
        detail = get_failure_detail.invoke({"repository": "task-service"})
        missing_detail = get_failure_detail.invoke({"repository": "unknown-service"})

        self.assertIn('"passed": 31', report)
        self.assertIn('"failed": 2', report)
        self.assertIn('"found": false', missing_report)
        self.assertIn('"location": "src/tasks/task.service.spec.ts:84"', detail)
        self.assertIn('"found": false', missing_detail)

    def test_extract_business_tool_path_filters_non_business_tools(self):
        messages = [
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "get_latest_test_report", "args": {}, "id": "call_1"},
                    {"name": "internal_output_tool", "args": {}, "id": "call_2"},
                    {"name": "get_failure_detail", "args": {}, "id": "call_3"},
                ],
            )
        ]

        self.assertEqual(
            extract_business_tool_path(messages),
            ["get_latest_test_report", "get_failure_detail"],
        )

    def test_finalize_analysis_requires_structured_result(self):
        with self.assertRaises(RuntimeError):
            finalize_analysis({"taskId": "DEV-1024", "riskAnalysis": None})

    def test_build_agent_prompt_contains_task_fields(self):
        prompt = build_agent_prompt(
            {
                "taskId": "DEV-1024",
                "title": "为任务列表增加 priority 筛选",
                "owner": "小明",
                "dueDate": "2026-08-20",
                "repository": "task-service",
            }
        )

        self.assertIn("任务编号：DEV-1024", prompt)
        self.assertIn("任务名称：为任务列表增加 priority 筛选", prompt)
        self.assertIn("代码仓库：task-service", prompt)

    def test_create_model_requires_api_key_without_reading_env_file(self):
        old_value = os.environ.pop("DEEPSEEK_API_KEY", None)

        try:
            with self.assertRaises(RuntimeError) as error:
                create_model()

            self.assertIn("缺少 DEEPSEEK_API_KEY", str(error.exception))
        finally:
            if old_value is not None:
                os.environ["DEEPSEEK_API_KEY"] = old_value

    def test_mermaid_contains_workflow_nodes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            mermaid = print_mermaid()

        self.assertIn("load_task", mermaid)
        self.assertIn("handle_missing", mermaid)
        self.assertIn("handle_completed", mermaid)
        self.assertIn("risk_agent", mermaid)
        self.assertIn("finalize_analysis", mermaid)


if __name__ == "__main__":
    unittest.main()

import json
import sys
import unittest
from pathlib import Path

from langchain_core.messages import AIMessage, ToolMessage


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from create_agent_demo import (  # noqa: E402
    QUESTION,
    format_trajectory,
    get_latest_test_report,
    get_task,
    handle_update,
    message_text,
    parse_tool_result,
)


class CreateAgentDemoTest(unittest.TestCase):
    def test_get_task_returns_repository_for_next_tool(self):
        result = json.loads(get_task.invoke({"taskId": "DEV-1024"}))

        self.assertTrue(result["found"])
        self.assertEqual(result["taskId"], "DEV-1024")
        self.assertEqual(result["repository"], "task-service")
        self.assertEqual(result["dueDate"], "2026-08-15")

    def test_get_latest_test_report_uses_repository_from_task(self):
        task = json.loads(get_task.invoke({"taskId": "DEV-1024"}))
        report = json.loads(
            get_latest_test_report.invoke({"repository": task["repository"]})
        )

        self.assertTrue(report["found"])
        self.assertEqual(report["repository"], "task-service")
        self.assertEqual(report["branch"], "feature/priority-filter")
        self.assertEqual(report["passed"], 31)
        self.assertEqual(report["failed"], 2)
        self.assertEqual(
            report["failures"],
            ["priority 参数为空时，没有使用默认值", "priority=high 时返回了 medium 任务"],
        )

    def test_invalid_task_id_is_rejected_by_schema(self):
        with self.assertRaises(Exception) as context:
            get_task.invoke({"taskId": "1024"})

        self.assertIn("DEV-", str(context.exception))

    def test_handle_update_collects_messages_and_logs_key_nodes(self):
        trajectory = []
        decision = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "get_task",
                    "args": {"taskId": "DEV-1024"},
                    "id": "call_1",
                }
            ],
        )
        tool_message = ToolMessage(
            content=get_task.invoke({"taskId": "DEV-1024"}),
            tool_call_id="call_1",
            name="get_task",
        )

        logs = handle_update({"model": {"messages": [decision]}}, trajectory)
        logs += handle_update({"tools": {"messages": [tool_message]}}, trajectory)

        self.assertEqual(len(trajectory), 2)
        self.assertIn("模型请求调用 get_task", logs[0])
        self.assertIn("get_task 执行完成", logs[1])

    def test_format_trajectory_shows_multi_round_tool_chain(self):
        task_decision = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "get_task",
                    "args": {"taskId": "DEV-1024"},
                    "id": "call_1",
                }
            ],
        )
        task_message = ToolMessage(
            content=get_task.invoke({"taskId": "DEV-1024"}),
            tool_call_id="call_1",
            name="get_task",
        )
        report_decision = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "get_latest_test_report",
                    "args": {"repository": "task-service"},
                    "id": "call_2",
                }
            ],
        )
        report_message = ToolMessage(
            content=get_latest_test_report.invoke({"repository": "task-service"}),
            tool_call_id="call_2",
            name="get_latest_test_report",
        )
        final_answer = AIMessage(content="风险等级：中高。")

        lines = format_trajectory(
            [task_decision, task_message, report_decision, report_message, final_answer],
            question=QUESTION,
        )
        text = "\n".join(lines)

        self.assertIn("01. HumanMessage", text)
        self.assertIn('AIMessage：get_task({"taskId": "DEV-1024"})', text)
        self.assertIn("ToolMessage：get_task", text)
        self.assertIn('AIMessage：get_latest_test_report({"repository": "task-service"})', text)
        self.assertIn("ToolMessage：get_latest_test_report", text)
        self.assertIn("AIMessage：最终回答", text)

    def test_parse_tool_result_and_message_text(self):
        message = ToolMessage(
            content='{"found": true, "repository": "task-service"}',
            tool_call_id="call_1",
            name="get_task",
        )

        self.assertEqual(
            parse_tool_result(message),
            {"found": True, "repository": "task-service"},
        )
        self.assertEqual(message_text(AIMessage(content="hello")), "hello")


if __name__ == "__main__":
    unittest.main()

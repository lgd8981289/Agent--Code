import contextlib
import io
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from task_routing_graph import (  # noqa: E402
    append_execution_path,
    print_mermaid,
    route_task,
    task_routing_graph,
)


class TaskRoutingGraphTest(unittest.TestCase):
    def invoke_quietly(self, task_id):
        with contextlib.redirect_stdout(io.StringIO()):
            return task_routing_graph.invoke({"taskId": task_id})

    def test_active_task_branch(self):
        result = self.invoke_quietly("DEV-1024")

        self.assertEqual(result["executionPath"], ["load_task", "handle_active"])
        self.assertEqual(result["task"]["taskId"], "DEV-1024")
        self.assertEqual(result["result"]["type"], "active")
        self.assertEqual(
            result["result"]["summary"],
            "为任务列表增加 priority 筛选 当前由 小明 负责，任务仍在进行中。",
        )
        self.assertEqual(
            result["result"]["nextAction"],
            "继续推进开发，并在 2026-08-20 前完成测试。",
        )

    def test_completed_task_branch(self):
        result = self.invoke_quietly("DEV-2048")

        self.assertEqual(result["executionPath"], ["load_task", "handle_completed"])
        self.assertEqual(result["task"]["taskId"], "DEV-2048")
        self.assertEqual(result["result"]["type"], "completed")
        self.assertEqual(result["result"]["summary"], "修复导出文件名称乱码问题 已经完成。")
        self.assertEqual(
            result["result"]["nextAction"],
            "不再进入开发流程，可以继续检查发布或验收状态。",
        )

    def test_missing_task_branch(self):
        result = self.invoke_quietly("DEV-9999")

        self.assertEqual(result["executionPath"], ["load_task", "handle_missing"])
        self.assertIsNone(result["task"])
        self.assertEqual(result["result"]["type"], "missing")
        self.assertEqual(result["result"]["summary"], "没有找到任务 DEV-9999。")
        self.assertEqual(
            result["result"]["nextAction"],
            "请检查任务编号，补充有效编号以后再重新执行。",
        )

    def test_route_task(self):
        self.assertEqual(route_task({"taskId": "DEV-9999", "task": None}), "missing")
        self.assertEqual(
            route_task(
                {
                    "taskId": "DEV-2048",
                    "task": {
                        "status": "completed",
                    },
                }
            ),
            "completed",
        )
        self.assertEqual(
            route_task(
                {
                    "taskId": "DEV-1024",
                    "task": {
                        "status": "in_progress",
                    },
                }
            ),
            "active",
        )

    def test_execution_path_reducer(self):
        self.assertEqual(append_execution_path(None, "load_task"), ["load_task"])
        self.assertEqual(
            append_execution_path(["load_task"], "handle_active"),
            ["load_task", "handle_active"],
        )
        self.assertEqual(
            append_execution_path(["load_task"], ["handle_active"]),
            ["load_task", "handle_active"],
        )

    def test_stream_updates(self):
        with contextlib.redirect_stdout(io.StringIO()):
            updates = list(
                task_routing_graph.stream(
                    {"taskId": "DEV-1024"},
                    stream_mode="updates",
                )
            )

        self.assertEqual(len(updates), 2)
        self.assertEqual(list(updates[0].keys()), ["load_task"])
        self.assertEqual(list(updates[1].keys()), ["handle_active"])
        self.assertEqual(updates[0]["load_task"]["executionPath"], "load_task")
        self.assertEqual(updates[1]["handle_active"]["executionPath"], "handle_active")

    def test_mermaid_contains_graph_nodes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            mermaid = print_mermaid()

        self.assertIn("load_task", mermaid)
        self.assertIn("handle_active", mermaid)
        self.assertIn("handle_completed", mermaid)
        self.assertIn("handle_missing", mermaid)


if __name__ == "__main__":
    unittest.main()

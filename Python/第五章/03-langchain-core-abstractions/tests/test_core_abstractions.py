import json
import sys
import unittest
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableLambda


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core_abstractions import (  # noqa: E402
    build_task_summary_runnable,
    get_task,
    message_text,
    task_json_to_messages,
)


class CoreAbstractionsTest(unittest.TestCase):
    def test_get_task_returns_existing_task(self):
        result = json.loads(get_task.invoke({"taskId": "DEV-1024"}))

        self.assertTrue(result["found"])
        self.assertEqual(result["taskId"], "DEV-1024")
        self.assertEqual(result["title"], "为任务列表增加 priority 筛选")
        self.assertEqual(result["status"], "in_progress")
        self.assertEqual(result["owner"], "小明")
        self.assertEqual(result["dueDate"], "2026-08-12")

    def test_get_task_rejects_invalid_task_id_before_function_runs(self):
        with self.assertRaises(Exception) as context:
            get_task.invoke({"taskId": "1024"})

        self.assertIn("DEV-", str(context.exception))

    def test_get_task_returns_not_found_shape(self):
        result = json.loads(get_task.invoke({"taskId": "DEV-9999"}))

        self.assertFalse(result["found"])
        self.assertEqual(result["taskId"], "DEV-9999")
        self.assertEqual(result["message"], "没有找到对应的研发任务")

    def test_task_json_to_messages_builds_system_and_human_messages(self):
        messages = task_json_to_messages('{"taskId":"DEV-2048"}')

        self.assertIsInstance(messages[0], SystemMessage)
        self.assertIsInstance(messages[1], HumanMessage)
        self.assertIn("任务数据：", messages[1].content)
        self.assertIn("DEV-2048", messages[1].content)

    def test_runnable_pipeline_keeps_fixed_step_order(self):
        seen = {}

        def fake_model(messages):
            seen["message_types"] = [message.__class__.__name__ for message in messages]
            seen["human_content"] = messages[-1].content
            task_json = seen["human_content"].removeprefix("任务数据：")
            task = json.loads(task_json)
            return AIMessage(content=f"摘要：{task['taskId']} 当前由 {task['owner']} 负责。")

        runnable = build_task_summary_runnable(model=RunnableLambda(fake_model))
        result = runnable.invoke({"taskId": "DEV-2048"})

        self.assertEqual(seen["message_types"], ["SystemMessage", "HumanMessage"])
        self.assertIn("waiting_for_test", seen["human_content"])
        self.assertEqual(result, "摘要：DEV-2048 当前由 小李 负责。")

    def test_message_text_handles_string_content(self):
        self.assertEqual(message_text(AIMessage(content="hello")), "hello")


if __name__ == "__main__":
    unittest.main()

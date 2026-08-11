import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from langchain_agent import final_message_text, get_order_status  # noqa: E402


class LangChainAgentTest(unittest.TestCase):
    def test_get_order_status_returns_expected_json(self):
        result = json.loads(get_order_status.invoke({"order_id": "A1024"}))

        self.assertEqual(result["orderId"], "A1024")
        self.assertEqual(result["status"], "waiting_for_manual_review")
        self.assertEqual(result["message"], "退款金额超过 2000 元，正在等待人工审核")

    def test_final_message_text_handles_message_object(self):
        class FakeMessage:
            content = "订单 A1024 正在等待人工审核。"

        result = final_message_text({"messages": [FakeMessage()]})

        self.assertEqual(result, "订单 A1024 正在等待人工审核。")

    def test_final_message_text_handles_dict_message(self):
        result = final_message_text(
            {"messages": [{"role": "assistant", "content": "订单正在处理中。"}]}
        )

        self.assertEqual(result, "订单正在处理中。")


if __name__ == "__main__":
    unittest.main()

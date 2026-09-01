import contextlib
import io
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langgraph.checkpoint.memory import InMemorySaver


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import memory_session  # noqa: E402
from session import create_memory_agent  # noqa: E402


class MemorySessionEntryTest(unittest.TestCase):
    def test_main_shows_continued_isolated_and_unauthorized_scenarios(self):
        model = FakeListChatModel(
            responses=[
                "已记录退款金额",
                "订单 A1024，退款金额 3000 元",
                "当前会话没有订单信息",
            ]
        )
        fake_agent = create_memory_agent(InMemorySaver(), model)
        old_value = os.environ.get("DEEPSEEK_API_KEY")
        os.environ["DEEPSEEK_API_KEY"] = "fake-key-for-offline-test"

        try:
            with patch.object(memory_session, "create_memory_agent", return_value=fake_agent):
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    memory_session.main()

            output = stdout.getvalue()
            self.assertIn("同一个 Thread：第二轮接续第一轮 State", output)
            self.assertIn("不同 Thread：没有继承其他会话消息", output)
            self.assertIn("越权访问验证", output)
            self.assertIn("用户 user-1002 无权访问 Thread support-user-1001。", output)
        finally:
            if old_value is None:
                os.environ.pop("DEEPSEEK_API_KEY", None)
            else:
                os.environ["DEEPSEEK_API_KEY"] = old_value


if __name__ == "__main__":
    unittest.main()

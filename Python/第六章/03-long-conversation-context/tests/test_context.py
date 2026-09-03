import contextlib
import io
import os
import sys
import unittest
from pathlib import Path

from langchain_core.language_models.fake_chat_models import FakeListChatModel


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from automatic_compaction import (  # noqa: E402
    USER_MESSAGES,
    create_compaction_agent,
    create_model,
    find_summary_message,
    run_conversation,
)
from compare_context import print_strategy  # noqa: E402
from context import (  # noqa: E402
    create_expected_compacted_context,
    create_long_conversation,
    includes_fact,
    measure_context,
    message_text,
    trim_to_recent_messages,
)


class LongConversationContextTest(unittest.TestCase):
    def test_trim_recent_messages_reduces_context_but_may_drop_early_facts(self):
        full_history = create_long_conversation()
        trimmed_history = trim_to_recent_messages(full_history)

        self.assertLess(len(trimmed_history), len(full_history))
        self.assertFalse(includes_fact(trimmed_history, "A2048"))
        self.assertFalse(includes_fact(trimmed_history, "3800"))

    def test_summary_plus_recent_messages_keeps_key_facts(self):
        full_history = create_long_conversation()
        compacted_history = create_expected_compacted_context(full_history)

        self.assertLess(
            measure_context(compacted_history)["characterCount"],
            measure_context(full_history)["characterCount"],
        )
        self.assertTrue(includes_fact(compacted_history, "A2048"))
        self.assertTrue(includes_fact(compacted_history, "3800"))
        self.assertTrue(includes_fact(compacted_history, "没有上传破损照片"))
        self.assertTrue(includes_fact(compacted_history, "禁止直接提交"))

    def test_measure_context_counts_messages_and_characters(self):
        full_history = create_long_conversation()
        size = measure_context(full_history)

        self.assertEqual(size["messageCount"], 9)
        self.assertEqual(
            size["characterCount"],
            sum(len(message_text(message)) for message in full_history),
        )

    def test_print_strategy_contains_fact_flags(self):
        full_history = create_long_conversation()

        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            print_strategy("方案一：完整历史", full_history)

        output = stdout.getvalue()
        self.assertIn("方案一：完整历史", output)
        self.assertIn("保留订单号：True", output)
        self.assertIn("human", output)

    def test_summarization_middleware_writes_summary_after_threshold(self):
        # 前四轮各消耗一次 Agent 回答；
        # 第五轮先触发摘要，再生成本轮回答。
        model = FakeListChatModel(
            responses=[
                "已记录本轮信息。",
                "已记录本轮信息。",
                "已记录本轮信息。",
                "已记录本轮信息。",
                "订单 A2048，金额 3800 元，缺少破损照片；只能说明流程，不能提交退款。",
                "需要人工审核，还缺少破损照片。",
            ]
        )
        agent = create_compaction_agent(model)

        with contextlib.redirect_stdout(io.StringIO()):
            states = run_conversation(agent, USER_MESSAGES)

        summary = find_summary_message(states[-1]["messages"])

        self.assertIsNotNone(summary)
        self.assertIn("以下是较早对话的摘要：", message_text(summary))
        self.assertIn("订单 A2048", message_text(summary))
        self.assertLess(len(states[-1]["messages"]), 10)

    def test_create_model_requires_api_key_without_reading_env_file(self):
        old_value = os.environ.pop("DEEPSEEK_API_KEY", None)

        try:
            with self.assertRaises(RuntimeError) as error:
                create_model()

            self.assertIn("缺少 DEEPSEEK_API_KEY", str(error.exception))
        finally:
            if old_value is not None:
                os.environ["DEEPSEEK_API_KEY"] = old_value


if __name__ == "__main__":
    unittest.main()

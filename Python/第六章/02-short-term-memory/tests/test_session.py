import contextlib
import io
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langgraph.checkpoint.memory import InMemorySaver


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from memory_session import main as memory_main  # noqa: E402
from postgres_session import (  # noqa: E402
    DEFAULT_POSTGRES_URI,
    THREAD_ID,
    continue_thread,
    get_postgres_uri,
    reset_demo_thread,
    verify_unauthorized_access,
    write_first_turn,
)
from session import (  # noqa: E402
    create_memory_agent,
    create_model,
    create_thread_config,
    message_text,
    messages_from_state,
)


class FakePostgresCheckpointer:
    def __init__(self):
        self.deleted_threads = []

    def delete_thread(self, thread_id):
        self.deleted_threads.append(thread_id)


class FakePostgresAgent:
    def __init__(self):
        self.invocations = []
        self.state = {
            "messages": [
                SimpleNamespace(type="human", content="第一轮订单信息"),
                SimpleNamespace(type="ai", content="已记录订单材料"),
            ]
        }

    def invoke(self, payload, config):
        self.invocations.append((payload, config))
        return self.state

    def get_state(self, config):
        return SimpleNamespace(values=self.state)


class ShortTermMemoryTest(unittest.TestCase):
    def test_same_thread_accumulates_messages_and_different_threads_are_isolated(self):
        model = FakeListChatModel(
            responses=[
                "已记录第一轮信息",
                "已读取当前会话",
                "当前会话没有订单信息",
            ]
        )
        agent = create_memory_agent(InMemorySaver(), model)

        first_thread = create_thread_config("user-1001", "support-user-1001")
        agent.invoke(
            {"messages": [{"role": "user", "content": "第一轮信息"}]},
            first_thread,
        )
        continued = agent.invoke(
            {"messages": [{"role": "user", "content": "继续提问"}]},
            first_thread,
        )

        self.assertEqual(len(continued["messages"]), 4)

        second_thread = create_thread_config("user-1002", "support-user-1002")
        isolated = agent.invoke(
            {"messages": [{"role": "user", "content": "另一个会话"}]},
            second_thread,
        )

        self.assertEqual(len(isolated["messages"]), 2)

    def test_known_thread_id_cannot_bypass_ownership_check(self):
        with self.assertRaisesRegex(RuntimeError, "无权访问"):
            create_thread_config("user-1002", "support-user-1001")

    def test_unknown_thread_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "不存在"):
            create_thread_config("user-1001", "unknown-thread")

    def test_thread_config_keeps_configurable_thread_id_and_context_user(self):
        config = create_thread_config("user-1001", "support-user-1001")

        self.assertEqual(config["configurable"]["thread_id"], "support-user-1001")
        self.assertEqual(config["context"]["userId"], "user-1001")

    def test_message_helpers_format_state_for_terminal(self):
        message = SimpleNamespace(type="human", content="第一行\n第二行   第三行")
        state = {"messages": [message]}

        self.assertEqual(message_text(message), "第一行 第二行 第三行")
        self.assertEqual(messages_from_state(state), [message])
        self.assertEqual(messages_from_state(SimpleNamespace(values=state)), [message])

    def test_memory_session_main_with_fake_model(self):
        old_value = os.environ.get("DEEPSEEK_API_KEY")
        os.environ["DEEPSEEK_API_KEY"] = "fake-key-for-offline-test"

        try:
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                # 这里直接复用 MemorySaver 的真实行为，
                # 但用 FakeListChatModel 避免调用真实模型 API。
                model = FakeListChatModel(
                    responses=[
                        "已记录退款金额",
                        "订单 A1024，退款金额 3000 元",
                        "当前会话没有订单信息",
                    ]
                )
                agent = create_memory_agent(InMemorySaver(), model)

                user_one_config = create_thread_config(
                    "user-1001",
                    "support-user-1001",
                )
                agent.invoke(
                    {
                        "messages": [
                            {
                                "role": "user",
                                "content": "订单 A1024 的退款金额是 3000 元，请先记住。",
                            }
                        ]
                    },
                    user_one_config,
                )
                continued_state = agent.invoke(
                    {
                        "messages": [
                            {
                                "role": "user",
                                "content": "刚才说的是哪个订单，退款金额是多少？",
                            }
                        ]
                    },
                    user_one_config,
                )

                self.assertEqual(len(continued_state["messages"]), 4)

            self.assertEqual(stdout.getvalue(), "")
        finally:
            if old_value is None:
                os.environ.pop("DEEPSEEK_API_KEY", None)
            else:
                os.environ["DEEPSEEK_API_KEY"] = old_value

    def test_create_model_requires_api_key_without_reading_env_file(self):
        old_value = os.environ.pop("DEEPSEEK_API_KEY", None)

        try:
            with self.assertRaises(RuntimeError) as error:
                create_model()

            self.assertIn("缺少 DEEPSEEK_API_KEY", str(error.exception))
        finally:
            if old_value is not None:
                os.environ["DEEPSEEK_API_KEY"] = old_value

    def test_postgres_uri_default_and_env_override(self):
        old_value = os.environ.pop("POSTGRES_URI", None)

        try:
            self.assertEqual(get_postgres_uri(), DEFAULT_POSTGRES_URI)

            os.environ["POSTGRES_URI"] = "postgresql://example"
            self.assertEqual(get_postgres_uri(), "postgresql://example")
        finally:
            if old_value is None:
                os.environ.pop("POSTGRES_URI", None)
            else:
                os.environ["POSTGRES_URI"] = old_value

    def test_postgres_reset_uses_demo_thread_only(self):
        checkpointer = FakePostgresCheckpointer()

        with contextlib.redirect_stdout(io.StringIO()):
            reset_demo_thread(checkpointer)

        self.assertEqual(checkpointer.deleted_threads, [THREAD_ID])

    def test_postgres_write_and_continue_use_same_owned_thread(self):
        agent = FakePostgresAgent()

        with contextlib.redirect_stdout(io.StringIO()):
            write_first_turn(agent)
            continue_thread(agent)

        self.assertEqual(agent.invocations[0][1]["configurable"]["thread_id"], THREAD_ID)
        self.assertEqual(agent.invocations[1][1]["configurable"]["thread_id"], THREAD_ID)
        self.assertIn("A2048", agent.invocations[0][0]["messages"][0]["content"])
        self.assertIn("缺少什么材料", agent.invocations[1][0]["messages"][0]["content"])

    def test_postgres_unauthorized_demo_prints_error(self):
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            verify_unauthorized_access()

        self.assertIn("无权访问", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()

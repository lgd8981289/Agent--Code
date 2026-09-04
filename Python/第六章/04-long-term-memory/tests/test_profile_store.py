import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from langchain_core.language_models.fake_chat_models import FakeListChatModel, FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import store_basics  # noqa: E402
from profile_agent import (  # noqa: E402
    BLUEWHALE_USER,
    OTHER_TENANT,
    OTHER_USER,
    create_model,
    create_profile_agent,
    create_run_config,
    get_profile_from_runtime,
    invoke_with_principal,
    recall,
    reset,
    save_profile_from_runtime,
    verify_isolation,
)
from profile_store import (  # noqa: E402
    PROFILE_KEY,
    delete_user_profile,
    load_user_profile,
    profile_namespace,
    save_user_profile,
)
from storage import get_postgres_uri  # noqa: E402


class FakeRecallAgent:
    def invoke(self, payload, config, *, context):
        return {
            "messages": [
                SimpleNamespace(type="human", content=payload["messages"][0]["content"]),
                ToolMessage(
                    content=json.dumps(
                        {
                            "found": True,
                            "profile": {
                                "responseLanguage": "zh-CN",
                                "answerStyle": "conclusion_first",
                                "contactWindow": "工作日 19:00 以后",
                            },
                        },
                        ensure_ascii=False,
                    ),
                    tool_call_id="call_1",
                    name="get_user_profile",
                ),
                SimpleNamespace(type="ai", content="结论：超过阈值后需要人工审核。"),
            ]
        }


class ToolCallingFakeModel(FakeMessagesListChatModel):
    """支持 Tool Calling 的确定性测试模型。"""

    def bind_tools(self, *args, **kwargs):
        return self


class LongTermMemoryTest(unittest.TestCase):
    def setUp(self):
        self.store = InMemoryStore()
        self.owner = {
            "tenantId": "bluewhale",
            "userId": "user-1001",
        }

    def test_namespace_excludes_thread_id_and_keeps_node_path_values(self):
        self.assertEqual(
            profile_namespace(self.owner),
            (
                "agent-course",
                "tenants",
                "bluewhale",
                "users",
                "user-1001",
                "profiles",
            ),
        )

    def test_save_and_load_user_profile(self):
        saved = save_user_profile(
            self.store,
            self.owner,
            {
                "responseLanguage": "zh-CN",
                "answerStyle": "conclusion_first",
                "contactWindow": "工作日 19:00 以后",
            },
        )
        profile = load_user_profile(self.store, self.owner)

        self.assertEqual(profile["responseLanguage"], "zh-CN")
        self.assertEqual(profile["answerStyle"], "conclusion_first")
        self.assertEqual(profile["contactWindow"], "工作日 19:00 以后")
        self.assertEqual(profile["updatedAt"], saved["updatedAt"])

    def test_different_user_or_tenant_uses_different_namespace(self):
        save_user_profile(
            self.store,
            self.owner,
            {
                "responseLanguage": "zh-CN",
                "answerStyle": "conclusion_first",
                "contactWindow": "工作日 19:00 以后",
            },
        )

        self.assertIsNone(load_user_profile(self.store, OTHER_USER))
        self.assertIsNone(load_user_profile(self.store, OTHER_TENANT))

    def test_delete_user_profile_removes_current_key(self):
        save_user_profile(
            self.store,
            self.owner,
            {
                "responseLanguage": "zh-CN",
                "answerStyle": "conclusion_first",
                "contactWindow": "工作日 19:00 以后",
            },
        )

        delete_user_profile(self.store, self.owner)

        self.assertIsNone(load_user_profile(self.store, self.owner))

    def test_invalid_principal_is_rejected_before_namespace_write(self):
        with self.assertRaisesRegex(RuntimeError, "只能包含字母"):
            profile_namespace(
                {
                    "tenantId": "bluewhale",
                    "userId": "user/1001",
                }
            )

    def test_store_basics_writes_one_user_and_isolates_another_user(self):
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            store_basics.main()

        output = stdout.getvalue()
        self.assertIn("Thread A：保存用户画像", output)
        self.assertIn("Thread B：同一用户读取", output)
        self.assertIn("Thread C：另一名用户读取", output)
        self.assertIn("'responseLanguage': 'zh-CN'", output)
        self.assertTrue(output.rstrip().endswith("None"))

    def test_profile_tool_helpers_use_runtime_store_and_context(self):
        runtime = SimpleNamespace(
            store=self.store,
            context=BLUEWHALE_USER,
        )
        saved_text = save_profile_from_runtime(
            {
                "responseLanguage": "zh-CN",
                "answerStyle": "conclusion_first",
                "contactWindow": "工作日 19:00 以后",
            },
            runtime,
        )
        loaded_text = get_profile_from_runtime(runtime)

        self.assertTrue(json.loads(saved_text)["saved"])
        self.assertEqual(json.loads(loaded_text)["profile"]["responseLanguage"], "zh-CN")
        self.assertIsNotNone(self.store.get(profile_namespace(BLUEWHALE_USER), PROFILE_KEY))

    def test_profile_tool_helpers_require_store(self):
        runtime = SimpleNamespace(
            store=None,
            context=BLUEWHALE_USER,
        )

        with self.assertRaisesRegex(RuntimeError, "没有配置 Store"):
            get_profile_from_runtime(runtime)

    def test_create_profile_agent_can_compile_with_fake_model(self):
        storage = SimpleNamespace(
            checkpointer=InMemorySaver(),
            store=InMemoryStore(),
        )
        agent = create_profile_agent(
            storage,
            model=FakeListChatModel(responses=["ok"]),
        )

        self.assertEqual(type(agent).__name__, "CompiledStateGraph")

    def test_create_run_config_keeps_thread_id_and_runtime_context(self):
        config = create_run_config(BLUEWHALE_USER, "profile-write-thread-1001")

        self.assertEqual(config["configurable"]["thread_id"], "profile-write-thread-1001")
        self.assertNotIn("context", config)

    def test_real_tool_call_receives_runtime_store_and_context(self):
        storage = SimpleNamespace(
            checkpointer=InMemorySaver(),
            store=InMemoryStore(),
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "save_user_profile",
                            "args": {
                                "responseLanguage": "zh-CN",
                                "answerStyle": "conclusion_first",
                                "contactWindow": "工作日 19:00 以后",
                            },
                            "id": "call_1",
                        }
                    ],
                ),
                AIMessage(content="已保存偏好。"),
            ]
        )
        agent = create_profile_agent(storage, model=model)

        state = invoke_with_principal(
            agent,
            {
                "messages": [
                    {
                        "role": "user",
                        "content": "请记住我的沟通偏好。",
                    }
                ]
            },
            BLUEWHALE_USER,
            "profile-runtime-test",
        )

        self.assertEqual([message.type for message in state["messages"]], ["human", "ai", "tool", "ai"])
        self.assertEqual(
            load_user_profile(storage.store, BLUEWHALE_USER)["contactWindow"],
            "工作日 19:00 以后",
        )

    def test_verify_isolation_returns_three_rows(self):
        save_user_profile(
            self.store,
            BLUEWHALE_USER,
            {
                "responseLanguage": "zh-CN",
                "answerStyle": "conclusion_first",
                "contactWindow": "工作日 19:00 以后",
            },
        )

        with contextlib.redirect_stdout(io.StringIO()):
            rows = verify_isolation(self.store)

        self.assertEqual(
            [row["读取结果"] for row in rows],
            [True, False, False],
        )

    def test_reset_removes_all_course_profiles(self):
        for principal in [BLUEWHALE_USER, OTHER_USER, OTHER_TENANT]:
            save_user_profile(
                self.store,
                principal,
                {
                    "responseLanguage": "zh-CN",
                    "answerStyle": "conclusion_first",
                    "contactWindow": "工作日 19:00 以后",
                },
            )

        with contextlib.redirect_stdout(io.StringIO()):
            reset(self.store)

        for principal in [BLUEWHALE_USER, OTHER_USER, OTHER_TENANT]:
            self.assertIsNone(load_user_profile(self.store, principal))

    def test_recall_requires_get_profile_tool_message(self):
        with contextlib.redirect_stdout(io.StringIO()):
            recall(FakeRecallAgent())

    def test_get_postgres_uri_requires_explicit_environment_variable(self):
        old_value = os.environ.pop("POSTGRES_URI", None)

        try:
            with self.assertRaises(RuntimeError) as error:
                get_postgres_uri()

            self.assertIn("缺少 POSTGRES_URI", str(error.exception))
        finally:
            if old_value is not None:
                os.environ["POSTGRES_URI"] = old_value

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

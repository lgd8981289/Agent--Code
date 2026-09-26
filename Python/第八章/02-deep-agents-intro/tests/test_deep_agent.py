"""本节的离线验证：不调用真实 DeepSeek API。"""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from deepagents.backends import FilesystemBackend
from langchain_core.messages import AIMessage, ToolMessage

import deep_agent


class DeepAgentTests(unittest.TestCase):
    def test_main_requires_api_key_before_creating_agent(self) -> None:
        with (
            patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}),
            patch.object(deep_agent, "create_deep_agent") as create,
        ):
            with self.assertRaisesRegex(RuntimeError, "缺少 DEEPSEEK_API_KEY"):
                deep_agent.main()
            create.assert_not_called()

    def test_filesystem_backend_maps_virtual_path_into_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            backend = FilesystemBackend(root_dir=workspace, virtual_mode=True)

            result = backend.write(deep_agent.WORLD_PATH, "规则一：通信中断。\n")

            self.assertIsNone(result.error)
            self.assertEqual(result.path, deep_agent.WORLD_PATH)
            self.assertEqual(
                (workspace / "game" / "world.md").read_text(encoding="utf-8"),
                "规则一：通信中断。\n",
            )

    def test_message_text_and_print_run(self) -> None:
        tool_reply = ToolMessage(
            content="Updated file /game/world.md",
            name="write_file",
            tool_call_id="call-1",
            status="success",
        )
        result = {
            "messages": [
                AIMessage(content="", tool_calls=[{
                    "name": "write_file",
                    "args": {"file_path": deep_agent.WORLD_PATH, "content": "内容"},
                    "id": "call-1",
                }]),
                tool_reply,
                AIMessage(content=[{"type": "text", "text": "世界观已保存。"}]),
            ],
        }
        output = io.StringIO()

        with redirect_stdout(output):
            deep_agent.print_run(result)

        self.assertIn("模型请求调用 write_file", output.getvalue())
        self.assertIn("工具 write_file 返回： Updated file /game/world.md", output.getvalue())
        self.assertIn("最终回答： 世界观已保存。", output.getvalue())

    def test_verify_world_requires_successful_write_and_nonempty_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            file_path = workspace / "game" / "world.md"
            file_path.parent.mkdir()
            file_path.write_text("规则一：保持供氧。", encoding="utf-8")
            success = ToolMessage(
                content="Updated file /game/world.md",
                name="write_file",
                tool_call_id="call-1",
                status="success",
            )
            self.assertEqual(deep_agent.verify_world({"messages": [success]}, workspace), file_path)

            failure = ToolMessage(
                content="Error writing file '/game/world.md'",
                name="write_file",
                tool_call_id="call-1",
                status="error",
            )
            with self.assertRaisesRegex(RuntimeError, "没有成功写入"):
                deep_agent.verify_world({"messages": [failure]}, workspace)

            file_path.write_text("  \n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "内容为空"):
                deep_agent.verify_world({"messages": [success]}, workspace)

    def test_main_builds_agent_and_checks_result_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake_reply = ToolMessage(
                content="Updated file /game/world.md",
                name="write_file",
                tool_call_id="call-1",
                status="success",
            )

            class FakeAgent:
                def invoke(self, inputs: object, config: object) -> dict[str, object]:
                    self.inputs = inputs
                    self.config = config
                    (workspace / "game").mkdir()
                    (workspace / "game" / "world.md").write_text("三条世界规则。", encoding="utf-8")
                    return {"messages": [fake_reply, AIMessage(content="已完成。")]}

            fake_agent = FakeAgent()
            output = io.StringIO()
            with (
                patch.dict(os.environ, {"DEEPSEEK_API_KEY": "offline-test-key"}),
                patch.object(deep_agent, "WORKSPACE_DIR", workspace),
                patch.object(deep_agent, "ChatDeepSeek") as model_class,
                patch.object(deep_agent, "create_deep_agent", return_value=fake_agent) as create,
                redirect_stdout(output),
            ):
                deep_agent.main()

            model_class.assert_called_once_with(model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"), temperature=0)
            self.assertIs(create.call_args.kwargs["model"], model_class.return_value)
            backend = create.call_args.kwargs["backend"]
            self.assertIsInstance(backend, FilesystemBackend)
            self.assertEqual(backend.cwd, workspace.resolve())
            self.assertTrue(backend.virtual_mode)
            self.assertEqual(create.call_args.kwargs["system_prompt"], deep_agent.SYSTEM_PROMPT)
            self.assertEqual(
                fake_agent.inputs,
                {"messages": [{"role": "user", "content": deep_agent.USER_REQUEST}]},
            )
            self.assertEqual(fake_agent.config, {"recursion_limit": 20})
            self.assertIn(str(workspace / "game" / "world.md"), output.getvalue())


if __name__ == "__main__":
    unittest.main()

"""Workspace 的离线行为验证，不调用模型或外部服务。"""

from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from deepagents.backends import FilesystemBackend

import workspace_demo


class WorkspaceDemoTests(unittest.TestCase):
    def test_bundled_files_match_default_documents(self) -> None:
        for virtual_path, expected in workspace_demo.DOCUMENTS.items():
            with self.subTest(path=virtual_path):
                actual_path = workspace_demo.WORKSPACE_DIR / virtual_path.lstrip("/")
                self.assertEqual(actual_path.read_text(encoding="utf-8"), expected)

    def test_initialize_missing_files_without_overwriting_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            existing = workspace / "game" / "world.md"
            existing.parent.mkdir(parents=True)
            existing.write_text("已经修改过的世界规则。\n", encoding="utf-8")
            backend = FilesystemBackend(root_dir=workspace, virtual_mode=True)

            workspace_demo.ensure_documents(backend, workspace)
            workspace_demo.ensure_documents(backend, workspace)

            self.assertEqual(existing.read_text(encoding="utf-8"), "已经修改过的世界规则。\n")
            self.assertEqual(
                (workspace / "game" / "characters.md").read_text(encoding="utf-8"),
                workspace_demo.DOCUMENTS["/game/characters.md"],
            )
            self.assertEqual(
                (workspace / "game" / "scenes" / "scene-01.md").read_text(encoding="utf-8"),
                workspace_demo.DOCUMENTS["/game/scenes/scene-01.md"],
            )
            self.assertEqual(
                workspace_demo.read_document(backend, "/game/world.md"),
                "已经修改过的世界规则。\n",
            )

    def test_read_missing_document_reports_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backend = FilesystemBackend(root_dir=Path(directory), virtual_mode=True)

            with self.assertRaisesRegex(RuntimeError, "missing.md"):
                workspace_demo.read_document(backend, "/game/missing.md")

    def test_context_lengths_and_main_output_match_node_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            output = io.StringIO()

            with patch.object(workspace_demo, "WORKSPACE_DIR", workspace), redirect_stdout(output):
                workspace_demo.main()

            all_paths = list(workspace_demo.DOCUMENTS)
            backend = FilesystemBackend(root_dir=workspace, virtual_mode=True)
            all_contents = [workspace_demo.read_document(backend, path) for path in all_paths]
            needed_contents = [workspace_demo.read_document(backend, path) for path in workspace_demo.NEEDED_PATHS]
            self.assertEqual(len("\n".join([workspace_demo.QUESTION, *all_contents])), 349)
            self.assertEqual(len("\n".join([workspace_demo.QUESTION, *needed_contents])), 200)

            text = output.getvalue()
            self.assertIn("待发送文本长度： 349 字符", text)
            self.assertIn("待发送文本长度： 200 字符", text)
            self.assertIn("方案 B 未加入模型输入：/game/characters.md", text)
            self.assertIn("观察点：场景写了“成功联系上地球”", text)


if __name__ == "__main__":
    unittest.main()

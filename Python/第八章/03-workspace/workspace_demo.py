"""用 Workspace 对比“全量读取”和“按需读取”的输入长度。"""

from __future__ import annotations

import os
from pathlib import Path

from deepagents.backends import FilesystemBackend


WORKSPACE_DIR = Path(__file__).resolve().parent / "workspace"

DOCUMENTS = {
    "/game/world.md": """# 世界观

故事发生在一座失去通信的太空站。
规则一：任何信息都无法从空间站传到外界，修复天线也不能恢复通信。
规则二：空气、水和能源有固定损耗，无法从外部补给。
规则三：所有谜团的原因都必须能在站内找到。
""",
    "/game/characters.md": """# 角色档案

林澜：空间站通信工程师，谨慎，习惯先排查设备故障。她知道通信断绝无法修复，但还没有向其他人说出原因。
周舟：空间站医生，负责照顾伤员，反对为节省物资而放弃救治。
陈岳：站长，负责分配剩余资源，隐瞒了上一轮物资盘点的异常。
每名角色都要有自己的目标；角色间的争执不能改变世界规则。
""",
    "/game/scenes/scene-01.md": """# 场景 01：控制室

林澜发现备用天线的电源仍然正常。她修好了天线，成功联系上地球。
地球方面答应派出救援飞船，站长因此决定停止物资配给。
""",
}

QUESTION = "场景 01 是否违反了已经确定的世界规则？"
NEEDED_PATHS = ["/game/world.md", "/game/scenes/scene-01.md"]


def ensure_documents(backend: FilesystemBackend, workspace_dir: Path) -> None:
    """确保 Workspace 中存在初始化所需的文档；已有文件不覆盖。"""

    # 确保 Workspace 根目录存在；如果父目录不存在则一并创建。
    workspace_dir.mkdir(parents=True, exist_ok=True)

    # 遍历预定义的所有文档：virtual_path 是虚拟路径，content 是文件内容。
    for virtual_path, content in DOCUMENTS.items():
        # 将类似 /game/world.md 的虚拟路径转换成真实磁盘路径。
        disk_path = workspace_dir / virtual_path.lstrip("/")

        try:
            # 检查文件是否已经存在；其他文件系统错误不能当成“缺失”。
            disk_path.stat()
        except FileNotFoundError:
            # 文件不存在时，通过 backend 创建文件并写入默认内容。
            result = backend.write(virtual_path, content)

            # backend 写入失败时，将错误继续向上抛出。
            if result.error:
                raise RuntimeError(result.error)


def read_document(backend: FilesystemBackend, virtual_path: str) -> str:
    """从 Python Backend 的 ReadResult 中取出文档原文。"""

    result = backend.read(virtual_path)
    # Python SDK 把正文放在 file_data["content"]，不是 Node 版的 result.content。
    content = result.file_data.get("content") if result.file_data else None
    if result.error or not isinstance(content, str):
        raise RuntimeError(result.error or f"无法读取 {virtual_path}")
    return content


def main() -> None:
    backend = FilesystemBackend(root_dir=WORKSPACE_DIR, virtual_mode=True)

    # 确保 Workspace 中存在初始化所需的文档。
    ensure_documents(backend, WORKSPACE_DIR)

    all_paths = list(DOCUMENTS)
    all_contents = [read_document(backend, path) for path in all_paths]
    needed_contents = [read_document(backend, path) for path in NEEDED_PATHS]

    all_messages_text = "\n".join([QUESTION, *all_contents])
    selected_messages_text = "\n".join([QUESTION, *needed_contents])

    print("本次任务：", QUESTION)
    print("Workspace 目录：", f"{WORKSPACE_DIR}{os.sep}")
    print("工作区已有文件：", "、".join(all_paths))
    print("\n方案 A：把所有文件正文放进下一次模型输入")
    print("读取文件：", "、".join(all_paths))
    print("待发送文本长度：", len(all_messages_text), "字符")
    print("\n方案 B：按当前问题读取需要的文件")
    print("读取文件：", "、".join(NEEDED_PATHS))
    print("待发送文本长度：", len(selected_messages_text), "字符")
    print("方案 B 未加入模型输入：/game/characters.md")
    print("\n核对用到的原文：")
    for virtual_path, content in zip(NEEDED_PATHS, needed_contents, strict=True):
        print(f"\n{virtual_path}\n{content}")
    print("观察点：场景写了“成功联系上地球”，世界观规定“无法恢复通信”。")


if __name__ == "__main__":
    main()

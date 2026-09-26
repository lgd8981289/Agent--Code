"""用 Deep Agent 生成互动剧情游戏的世界观初稿。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain_deepseek import ChatDeepSeek


WORKSPACE_DIR = Path(__file__).resolve().parent / "workspace"
WORLD_PATH = "/game/world.md"
SYSTEM_PROMPT = """你负责制作互动剧情游戏的世界观设定。
这次只交付世界观初稿：把三条明确且不冲突的世界规则保存到 /game/world.md。
交付前核对已经保存的内容，再向用户说明结果。"""
USER_REQUEST = "游戏发生在一座失去通信的太空站，请设计三条世界观规则。"


def _field(message: Any, name: str, default: Any = None) -> Any:
    """LangChain 消息通常是对象；离线测试也可以传入同结构字典。"""

    return message.get(name, default) if isinstance(message, dict) else getattr(message, name, default)


def message_text(message: Any) -> str:
    """兼容模型返回的纯文本及 text 内容块。"""

    content = _field(message, "content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "text"
    )


def print_run(result: dict[str, Any]) -> None:
    """按执行顺序打印模型的工具请求和工具返回。"""

    messages = result.get("messages", [])
    print("本次执行轨迹：")
    for message in messages:
        for call in _field(message, "tool_calls", []) or []:
            name = _field(call, "name")
            args = _field(call, "args")
            print(f"模型请求调用 {name}：", args)
        if _field(message, "tool_call_id"):
            print(f"工具 {_field(message, 'name')} 返回：", message_text(message))

    print("\n最终回答：", message_text(messages[-1]) if messages else "")


def verify_world(result: dict[str, Any], workspace_dir: Path) -> Path:
    """先确认 Agent 确实成功调用写入工具，再检查落盘文件。"""

    wrote_world = any(
        _field(message, "name") == "write_file"
        and _field(message, "tool_call_id")
        and _field(message, "status") == "success"
        and message_text(message).strip() == f"Updated file {WORLD_PATH}"
        for message in result.get("messages", [])
    )
    if not wrote_world:
        raise RuntimeError("Agent 没有成功写入 /game/world.md，请检查上面的工具调用轨迹。")

    # virtual_mode=True 把 Agent 看见的 /game/world.md 映射到本小节 workspace。
    output_path = workspace_dir / "game" / "world.md"
    if not output_path.read_text(encoding="utf-8").strip():
        raise RuntimeError("世界观文件已创建，但内容为空。")
    return output_path


def main() -> None:
    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先配置模型 API Key。")

    model = ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
    )
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    agent = create_deep_agent(
        model=model,
        backend=FilesystemBackend(root_dir=WORKSPACE_DIR, virtual_mode=True),
        system_prompt=SYSTEM_PROMPT,
    )
    result = agent.invoke(
        {"messages": [{"role": "user", "content": USER_REQUEST}]},
        {"recursion_limit": 20},
    )

    print_run(result)
    output_path = verify_world(result, WORKSPACE_DIR)
    print("\n生成的文件：", output_path)


if __name__ == "__main__":
    main()

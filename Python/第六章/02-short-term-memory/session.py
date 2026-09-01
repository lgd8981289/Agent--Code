"""
短期记忆示例的通用会话能力。

本文件对应 Node 版的 session.js，主要负责三件事：

- 创建课程统一使用的 Chat Model；
- 使用指定 Checkpointer 创建同一套知识客服 Agent；
- 在进入 Agent 以前校验 user_id 与 thread_id 的归属关系。

这里的重点不是让 thread_id 替代身份认证，
而是让 thread_id 只负责定位会话 State。
真实项目中，用户身份和会话归属应该来自后端认证系统和数据库。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any


"""
课程演示使用的会话归属关系。
真实项目应该从数据库读取，并在每次请求进入 Agent 以前校验。
"""
THREAD_OWNERS = {
    "support-user-1001": "user-1001",
    "support-user-1002": "user-1002",
    "support-postgres-1001": "user-1001",
}


def create_model():
    """创建本章统一使用的 Chat Model。"""

    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先加载你已有的 .env。")

    try:
        from langchain_deepseek import ChatDeepSeek
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langchain-deepseek 依赖，请先执行：python -m pip install -e ."
        ) from exc

    return ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
        max_retries=2,
    )


def create_memory_agent(checkpointer: Any, model: Any | None = None):
    """使用指定 Checkpointer 创建同一套知识客服 Agent。"""

    try:
        from langchain.agents import create_agent
    except ImportError as exc:
        raise RuntimeError("缺少 langchain 依赖，请先执行：python -m pip install -e .") from exc

    return create_agent(
        model=model or create_model(),
        tools=[],
        checkpointer=checkpointer,
        system_prompt="""你是企业售后知识客服。
只能根据当前会话中已经出现的信息回答，不得猜测订单数据。
回答尽量简洁；缺少信息时要明确说明。""",
    )


def create_thread_config(user_id: str, thread_id: str) -> dict[str, Any]:
    """校验当前用户是否拥有指定 Thread，并生成 Agent 调用配置。

    thread_id 只负责定位会话，
    不能替代身份认证和权限校验。
    """

    owner_id = THREAD_OWNERS.get(thread_id)

    if not owner_id:
        raise RuntimeError(f"Thread {thread_id} 不存在。")

    if owner_id != user_id:
        raise RuntimeError(f"用户 {user_id} 无权访问 Thread {thread_id}。")

    return {
        "configurable": {
            "thread_id": thread_id,
        },
        "context": {
            "userId": user_id,
        },
    }


def message_text(message: Any) -> str:
    """把 Message 内容整理成便于终端观察的短文本。"""

    content = getattr(message, "content", "")

    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False)

    return re.sub(r"\s+", " ", content).strip()[:100]


def message_type(message: Any) -> str:
    """读取 LangChain Python Message 类型。"""

    if hasattr(message, "type"):
        return str(message.type)

    if hasattr(message, "get_type"):
        return str(message.get_type())

    return type(message).__name__


def messages_from_state(state: Any) -> list[Any]:
    """兼容 Agent invoke 返回值和 get_state() 返回的 StateSnapshot。"""

    if isinstance(state, dict):
        return list(state.get("messages", []))

    if hasattr(state, "values"):
        return list(state.values.get("messages", []))

    return list(getattr(state, "messages", []))


def print_state(label: str, state: Any) -> None:
    """打印当前 State 中真实保存的消息，而不是只打印模型最终回答。"""

    messages = messages_from_state(state)

    print(f"\n========== {label} ==========")
    print(f"消息数量：{len(messages)}")

    rows = [
        {
            "序号": index + 1,
            "类型": message_type(message),
            "内容": message_text(message),
        }
        for index, message in enumerate(messages)
    ]

    for row in rows:
        print(f"{row['序号']:>2}. {row['类型']:<8} {row['内容']}")

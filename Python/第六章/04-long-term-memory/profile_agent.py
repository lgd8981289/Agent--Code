"""
使用 Store 保存和读取跨会话用户画像。

本文件对应 Node 版的 profile-agent.js。

短期记忆依赖 thread_id 读取当前会话 State；
长期记忆依赖 Store 的 Namespace + Key 读取用户画像。

本节重点是：

- 用户明确要求“记住”偏好时，把完整画像写入 Store；
- 新 Thread 中仍然可以按同一用户 Namespace 读取旧画像；
- 不同用户或不同租户不能读取对方画像。
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Literal

from langchain.tools import ToolRuntime
from langchain_core.tools import tool
from typing_extensions import TypedDict

from profile_store import delete_user_profile, load_user_profile, save_user_profile
from storage import close_storage, create_storage


BLUEWHALE_USER = {
    "tenantId": "bluewhale",
    "userId": "user-1001",
}


OTHER_USER = {
    "tenantId": "bluewhale",
    "userId": "user-1002",
}


OTHER_TENANT = {
    "tenantId": "star-retail",
    "userId": "user-1001",
}


class RuntimeContext(TypedDict):
    tenantId: str
    userId: str


def create_model():
    """创建本节使用的 DeepSeek Chat Model。"""

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


def save_profile_from_runtime(
    profile: dict[str, Any],
    runtime: ToolRuntime[RuntimeContext, Any],
) -> str:
    """把 Tool 收到的画像写入当前 Runtime Store。"""

    if runtime.store is None:
        raise RuntimeError("当前 Agent 没有配置 Store，无法保存长期记忆。")

    saved = save_user_profile(
        runtime.store,
        runtime.context,
        profile,
    )

    return json.dumps(
        {
            "saved": True,
            "profile": saved,
        },
        ensure_ascii=False,
    )


def get_profile_from_runtime(runtime: ToolRuntime[RuntimeContext, Any]) -> str:
    """从当前 Runtime Store 读取已登录用户画像。"""

    if runtime.store is None:
        raise RuntimeError("当前 Agent 没有配置 Store，无法读取长期记忆。")

    profile = load_user_profile(
        runtime.store,
        runtime.context,
    )

    return json.dumps(
        {
            "found": bool(profile),
            "profile": profile,
        },
        ensure_ascii=False,
    )


def create_profile_tools():
    """创建写入和读取用户画像的 Tool。"""

    @tool(
        "save_user_profile",
        description=(
            "当用户明确要求记住自己的回答语言、回答风格和人工联系时间时，"
            "保存完整用户画像。"
        ),
    )
    def save_profile(
        responseLanguage: Literal["zh-CN", "en-US"],
        answerStyle: Literal["conclusion_first", "detailed"],
        contactWindow: str,
        runtime: ToolRuntime[RuntimeContext, Any],
    ) -> str:
        profile = {
            "responseLanguage": responseLanguage,
            "answerStyle": answerStyle,
            "contactWindow": contactWindow,
        }

        return save_profile_from_runtime(profile, runtime)

    @tool(
        "get_user_profile",
        description="读取当前已登录用户保存的回答语言、回答风格和人工联系时间。",
    )
    def get_profile(runtime: ToolRuntime[RuntimeContext, Any]) -> str:
        return get_profile_from_runtime(runtime)

    return [save_profile, get_profile]


def create_profile_agent(storage: Any, model: Any | None = None):
    """使用同一套 Store 和 Checkpointer 创建用户偏好 Agent。"""

    try:
        from langchain.agents import create_agent
    except ImportError as exc:
        raise RuntimeError("缺少 langchain 依赖，请先执行：python -m pip install -e .") from exc

    return create_agent(
        model=model or create_model(),
        tools=create_profile_tools(),
        checkpointer=storage.checkpointer,
        store=storage.store,
        context_schema=RuntimeContext,
        system_prompt="""你是企业售后 Agent。
用户明确说“记住”沟通偏好时，必须调用 save_user_profile。
用户要求按照以前的偏好回答时，必须先调用 get_user_profile。
没有读取到画像时，要明确说明尚未保存，不能猜测。
用户和租户身份由 Runtime Context 提供，不要要求用户在对话中提供身份 ID。""",
    )


def create_run_config(principal: dict[str, str], thread_id: str) -> dict[str, Any]:
    """创建 Agent Config；生产项目中的 principal 应来自认证中间件。"""

    # Python LangChain 中，thread_id 仍然放在 config.configurable 中；
    # Runtime Context 需要在 invoke(..., context=principal) 中单独传入，
    # 这样 ToolRuntime.context 才能在 Tool 内读取到当前用户身份。
    return {
        "configurable": {
            "thread_id": thread_id,
        }
    }


def invoke_with_principal(
    agent: Any,
    payload: dict[str, Any],
    principal: dict[str, str],
    thread_id: str,
) -> dict[str, Any]:
    """使用同一套身份信息启动一次 Agent Run。"""

    return agent.invoke(
        payload,
        create_run_config(principal, thread_id),
        context=principal,
    )


def message_text(message: Any) -> str:
    content = getattr(message, "content", "")

    if isinstance(content, str):
        return re.sub(r"\s+", " ", content).strip()[:160]

    return json.dumps(content, ensure_ascii=False)[:160]


def message_type(message: Any) -> str:
    if hasattr(message, "type"):
        return str(message.type)

    if hasattr(message, "get_type"):
        return str(message.get_type())

    return type(message).__name__


def print_run(label: str, state: dict[str, Any]) -> None:
    """把一次 Agent Run 中的模型和 Tool 消息打印出来。"""

    print(f"\n========== {label} ==========")

    for index, message in enumerate(state["messages"], start=1):
        print(
            f"{index:>2}. {message_type(message):<8} "
            f"Tool={getattr(message, 'name', '') or ''} "
            f"{message_text(message)}"
        )


def remember(agent: Any, store: Any) -> None:
    """在 Thread A 中让 Agent 明确保存用户偏好。"""

    state = invoke_with_principal(
        agent,
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "请记住我的沟通偏好：以后使用中文回答，先给结论；"
                        "如果需要人工联系，请安排在工作日 19:00 以后。"
                    ),
                }
            ]
        },
        BLUEWHALE_USER,
        "profile-write-thread-1001",
    )

    print_run("Thread A：保存用户画像", state)

    profile = load_user_profile(store, BLUEWHALE_USER)

    if not profile:
        raise RuntimeError("模型没有成功调用 save_user_profile。")

    print("\nStore 中实际保存的画像：")
    print(profile)


def recall(agent: Any) -> None:
    """在全新的 Thread B 中读取 Store，并按照旧偏好回答。"""

    state = invoke_with_principal(
        agent,
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "这是一个新会话。请按照我以前保存的偏好，"
                        "告诉我订单超过退款阈值后应该怎样处理。"
                    ),
                }
            ]
        },
        BLUEWHALE_USER,
        "profile-read-thread-1001",
    )

    print_run("Thread B：读取长期记忆", state)

    used_profile_tool = any(
        message_type(message) == "tool" and getattr(message, "name", "") == "get_user_profile"
        for message in state["messages"]
    )

    if not used_profile_tool:
        raise RuntimeError("模型没有按照要求调用 get_user_profile。")


def verify_isolation(store: Any) -> list[dict[str, Any]]:
    """验证相同用户 ID 在不同租户、不同用户在相同租户中都无法读取该画像。"""

    rows = [
        {
            "读取身份": "bluewhale / user-1001",
            "读取结果": bool(load_user_profile(store, BLUEWHALE_USER)),
        },
        {
            "读取身份": "bluewhale / user-1002",
            "读取结果": bool(load_user_profile(store, OTHER_USER)),
        },
        {
            "读取身份": "star-retail / user-1001",
            "读取结果": bool(load_user_profile(store, OTHER_TENANT)),
        },
    ]

    print("\n========== 用户与租户隔离 ==========")

    for row in rows:
        print(f"{row['读取身份']}: {row['读取结果']}")

    return rows


def reset(store: Any) -> None:
    """删除三组课程数据，保证实验可以重新执行。"""

    for principal in [BLUEWHALE_USER, OTHER_USER, OTHER_TENANT]:
        delete_user_profile(store, principal)

    print("课程用户画像已经清理。")


def main(command: str | None = None) -> None:
    command = command or (sys.argv[1] if len(sys.argv) > 1 else "demo")
    storage = create_storage()

    try:
        if command == "reset":
            reset(storage.store)
            return

        if command == "isolation":
            verify_isolation(storage.store)
            return

        agent = create_profile_agent(storage)

        if command == "remember":
            remember(agent, storage.store)
            return

        if command == "recall":
            recall(agent)
            return

        if command == "demo":
            reset(storage.store)
            remember(agent, storage.store)
            recall(agent)
            verify_isolation(storage.store)
            return

        raise RuntimeError(f"未知命令：{command}")
    finally:
        close_storage(storage)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)

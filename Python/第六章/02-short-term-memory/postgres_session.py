"""
使用 PostgreSQL Checkpointer 演示跨进程短期记忆。

进程内 MemorySaver 只能在当前进程里保存 State；
PostgreSQL Checkpointer 会把 Thread State 保存到数据库，
因此 write 和 continue 可以在两个独立进程中执行。
"""

from __future__ import annotations

import os
import sys
from typing import Any

from session import create_memory_agent, create_thread_config, print_state


SUPPORTED_MODES = {
    "reset",
    "write",
    "continue",
    "unauthorized",
}
DEFAULT_POSTGRES_URI = "postgresql://agent_course:agent_course@localhost:5432/agent_memory"
THREAD_ID = "support-postgres-1001"


def get_postgres_uri() -> str:
    """获取 PostgreSQL 连接地址，不在代码中保存真实生产凭证。"""

    return os.getenv("POSTGRES_URI", DEFAULT_POSTGRES_URI)


def open_postgres_checkpointer(postgres_uri: str | None = None):
    """创建 PostgreSQL Checkpointer。

    Python 版 PostgresSaver.from_conn_string() 返回上下文管理器，
    因此调用方需要使用 with 打开并自动释放数据库连接。
    """

    try:
        from langgraph.checkpoint.postgres import PostgresSaver
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langgraph-checkpoint-postgres 依赖，请先执行：python -m pip install -e ."
        ) from exc

    return PostgresSaver.from_conn_string(postgres_uri or get_postgres_uri())


def write_first_turn(agent: Any) -> None:
    """向固定 Thread 写入第一轮消息，随后结束当前进程。"""

    config = create_thread_config("user-1001", THREAD_ID)
    state = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "请记住：订单 A2048 当前缺少商品损坏照片，需要用户补充以后再审核。",
                }
            ]
        },
        config,
    )

    print_state("第一次进程：写入 PostgreSQL", state)
    print("\n现在结束进程，再执行 python postgres_session.py continue。")


def continue_thread(agent: Any) -> None:
    """在新的 Python 进程中加载相同 Thread，并继续提问。"""

    config = create_thread_config("user-1001", THREAD_ID)
    state_before_invoke = agent.get_state(config)

    print_state("第二次进程：调用模型以前先恢复 State", state_before_invoke.values)

    state_after_invoke = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "这个订单还缺少什么材料？",
                }
            ]
        },
        config,
    )

    print_state("第二次进程：在恢复后的 State 上继续执行", state_after_invoke)


def verify_unauthorized_access() -> None:
    """验证其他用户不能借助已知 thread_id 读取会话。"""

    print("\n========== PostgreSQL 会话越权验证 ==========")

    try:
        create_thread_config("user-1002", THREAD_ID)
    except RuntimeError as error:
        print(error)


def reset_demo_thread(checkpointer: Any) -> None:
    """只清理当前案例使用的 Thread，方便重复执行实验。"""

    checkpointer.delete_thread(THREAD_ID)
    print(f"已清理 Thread：{THREAD_ID}")


def main(mode: str | None = None) -> None:
    mode = mode if mode is not None else (sys.argv[1] if len(sys.argv) > 1 else None)

    if mode not in SUPPORTED_MODES:
        raise RuntimeError(
            "命令参数必须是 reset、write、continue 或 unauthorized。请通过 README 中的命令运行。"
        )

    if mode == "unauthorized":
        verify_unauthorized_access()
        return

    with open_postgres_checkpointer() as checkpointer:
        # 首次使用 PostgreSQL Checkpointer 时，
        # 需要创建 LangGraph 保存 checkpoint 所需的数据表。
        checkpointer.setup()

        if mode == "reset":
            reset_demo_thread(checkpointer)
            return

        agent = create_memory_agent(checkpointer)

        if mode == "write":
            write_first_turn(agent)
            return

        continue_thread(agent)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        raise

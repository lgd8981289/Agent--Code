"""
使用进程内 MemorySaver 演示短期记忆。

这个脚本在同一个 Python 进程里验证：

1. 相同 Thread 能够接续已有 State；
2. 不同 Thread 相互隔离；
3. thread_id 不能替代用户权限校验。
"""

from __future__ import annotations

import sys

from langgraph.checkpoint.memory import InMemorySaver

from session import create_memory_agent, create_thread_config, print_state


def main() -> None:
    checkpointer = InMemorySaver()
    agent = create_memory_agent(checkpointer)

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

    print_state("同一个 Thread：第二轮接续第一轮 State", continued_state)

    user_two_config = create_thread_config(
        "user-1002",
        "support-user-1002",
    )

    isolated_state = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "刚才说的是哪个订单，退款金额是多少？",
                }
            ]
        },
        user_two_config,
    )

    print_state("不同 Thread：没有继承其他会话消息", isolated_state)

    print("\n========== 越权访问验证 ==========")

    try:
        create_thread_config("user-1002", "support-user-1001")
    except RuntimeError as error:
        print(error)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        raise

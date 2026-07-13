"""原生 Tool Calling 完整调用链演示。"""

from __future__ import annotations

import json
import os
import pprint
import sys
from typing import Any, Callable

from deepseek_client import MODEL, call_deepseek
from tools import execute_tool_call, tools


# 最大模型调用轮次。
#
# 可以通过环境变量 MAX_TOOL_ROUNDS 调整，
# 如果配置值不是正整数，则使用默认值 4。
def _read_max_tool_rounds() -> int:
    try:
        configured = int(os.getenv("MAX_TOOL_ROUNDS", "4"))
    except ValueError:
        return 4
    return configured if configured > 0 else 4


MAX_TOOL_ROUNDS = _read_max_tool_rounds()
CallModel = Callable[..., dict[str, Any]]
ExecuteTool = Callable[[dict[str, Any]], dict[str, Any]]


def run_tool_calling(
    question: str,
    *,
    call_model: CallModel = call_deepseek,
    execute_tool: ExecuteTool = execute_tool_call,
    max_tool_rounds: int = MAX_TOOL_ROUNDS,
) -> dict[str, Any]:
    """执行完整的 Tool Calling 调用链。

    整体流程：

    1. 将用户问题和工具说明发送给模型
    2. 模型判断是否需要调用工具
    3. 应用程序执行模型指定的真实工具
    4. 将工具执行结果追加到 messages
    5. 再次调用模型，让模型继续判断或生成最终答案

    为避免模型不断调用工具，整个流程受到最大轮次限制。
    """

    # 保存完整对话上下文。
    #
    # 后续每次调用模型时，都会把：
    # - 用户问题
    # - 模型提出的工具调用
    # - 工具执行结果
    #
    # 一起重新发送给模型。
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "你是星河零售的售后助手。订单信息必须通过 get_order 查询，不能猜测。"
                "判断退款时，必须先取得订单真实字段，再调用 check_refund_eligibility。"
                "请根据工具结果给出简洁结论。"
            ),
        },
        {
            "role": "user",
            "content": question,
        },
    ]

    # 记录每一轮模型调用的统计信息，
    # 包括停止原因、耗时和 Token 使用量。
    call_stats: list[dict[str, Any]] = []

    print(f"模型：{MODEL}")
    print(f"用户问题：{question}")

    # Tool Calling 本质上是一个循环。
    #
    # 每一轮都调用一次模型，直到：
    # - 模型不再请求调用工具，返回最终回答
    # - 或达到最大调用轮次
    for round_number in range(1, max_tool_rounds + 1):
        print(f"\n================ 第 {round_number} 轮模型调用 ================")

        # 将当前完整消息上下文和可用工具发送给模型。
        result = call_model(messages=messages, tools=tools)

        # 模型可能返回一个或多个工具调用请求。
        #
        # 如果没有 tool_calls，通常表示模型已经准备好输出最终回答。
        tool_calls = result["message"].get("tool_calls") or []

        # 保存本轮模型调用的统计信息。
        call_stats.append(
            {
                "round": round_number,
                "finishReason": result.get("finishReason"),
                "latencyMs": result.get("latencyMs"),
                "usage": result.get("usage"),
            }
        )

        print(f"finish_reason：{result.get('finishReason')}")

        # 没有工具调用请求，说明 Tool Calling 流程结束。
        #
        # 此时 message.content 就是模型基于前面工具结果
        # 生成的最终回答。
        if len(tool_calls) == 0:
            print("\n最终回答：")
            print(result["message"].get("content"))

            print("\n调用统计：")
            pprint.pp(call_stats)

            return {
                "answer": result["message"].get("content"),
                "messages": messages,
                "callStats": call_stats,
            }

        # 将模型返回的 assistant 消息追加到对话上下文。
        #
        # 这条消息中包含 tool_calls，
        # 后续的 tool 消息必须与这里的工具调用一一对应。
        messages.append(
            {
                "role": "assistant",
                "content": result["message"].get("content"),
                "tool_calls": tool_calls,
            }
        )

        # 模型一次可能提出多个工具调用请求，
        # 应用程序需要逐个执行。
        for tool_call in tool_calls:
            print("\n模型提出工具调用：")
            print(f"- tool_call_id：{tool_call.get('id')}")
            print(f"- 工具名称：{tool_call.get('function', {}).get('name')}")
            print(f"- 原始参数：{tool_call.get('function', {}).get('arguments')}")

            # 根据工具名称从工具注册表中找到真实函数，
            # 然后完成参数解析、参数校验和函数执行。
            tool_result = execute_tool(tool_call)

            print("应用程序执行结果：")
            pprint.pp(tool_result)

            # 将工具执行结果以 role: tool 的消息追加到 messages。
            #
            # 下一轮模型调用时，模型就可以读取这条工具结果，
            # 决定继续调用其他工具，还是生成最终答案。
            #
            # tool_call_id 用于告诉模型：
            # 当前结果对应前面哪一个工具调用请求。
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.get("id"),
                    "content": json.dumps(tool_result, ensure_ascii=False),
                }
            )

    # 达到最大轮次后主动终止。
    #
    # 这是一种安全保护，防止模型因为工具调用逻辑异常，
    # 在“模型调用 → 工具执行”之间无限循环。
    raise RuntimeError(
        f"已经达到最大工具调用轮次 {max_tool_rounds}，程序主动停止，避免无限调用。"
    )


def main(argv: list[str] | None = None) -> int:
    """从命令行读取用户问题并启动 Tool Calling 调用链。"""

    arguments = argv if argv is not None else sys.argv[1:]
    question = (
        " ".join(arguments)
        or "查询订单 A1024 是否满足退款条件，并告诉我是否需要人工审核。"
    )

    try:
        run_tool_calling(question)
    except Exception as error:
        print(f"\n执行失败： {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


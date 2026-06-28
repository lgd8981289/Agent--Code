"""演示如何在有限的 Context Window 内分配输入预算。"""

import math
from pprint import pprint
from typing import Any


MODEL_CONTEXT_LIMIT = 220
OUTPUT_RESERVE = 60
EXTERNAL_CONTEXT_RESERVE = 40

Message = dict[str, str]
Turn = list[Message]


def is_han_character(character: str) -> bool:
    """判断字符是否属于本示例需要处理的常见汉字范围。"""
    code_point = ord(character)
    return (
        0x3400 <= code_point <= 0x4DBF
        or 0x4E00 <= code_point <= 0x9FFF
        or 0xF900 <= code_point <= 0xFAFF
    )


def estimate_text_tokens(text: str) -> int:
    """粗略估算文本 Token 数量，不代表任何真实模型的 Tokenizer。"""
    chinese_count = sum(is_han_character(char) for char in text)
    other_count = len(text) - chinese_count
    return math.ceil(chinese_count * 0.7 + other_count / 4)


def estimate_message_tokens(message: Message) -> int:
    """估算一条消息正文以及 role、分隔符和模板的开销。"""
    return estimate_text_tokens(message["content"]) + 6


def estimate_messages_tokens(messages: list[Message]) -> int:
    """估算多条消息的 Token 总量。"""
    return sum(estimate_message_tokens(message) for message in messages)


def build_context(
    *,
    system_message: Message,
    summary_message: Message,
    history_turns: list[Turn],
    user_message: Message,
) -> dict[str, Any]:
    """保留必选消息，再从最近一轮开始装入完整历史轮次。"""
    input_budget = (
        MODEL_CONTEXT_LIMIT
        - OUTPUT_RESERVE
        - EXTERNAL_CONTEXT_RESERVE
    )
    required_messages = [system_message, summary_message, user_message]
    required_tokens = estimate_messages_tokens(required_messages)

    if required_tokens > input_budget:
        raise ValueError("必选内容已经超过输入预算，需要继续压缩摘要或当前输入。")

    remaining_budget = input_budget - required_tokens
    selected_turns: list[Turn] = []
    discarded_turns: list[Turn] = []

    for turn in reversed(history_turns):
        turn_tokens = estimate_messages_tokens(turn)
        if turn_tokens <= remaining_budget:
            selected_turns.insert(0, turn)
            remaining_budget -= turn_tokens
        else:
            discarded_turns.insert(0, turn)

    selected_messages = [
        message
        for turn in selected_turns
        for message in turn
    ]
    final_messages = [
        system_message,
        summary_message,
        *selected_messages,
        user_message,
    ]

    return {
        "messages": final_messages,
        "selectedTurns": selected_turns,
        "discardedTurns": discarded_turns,
        "inputBudget": input_budget,
        "usedInputTokens": estimate_messages_tokens(final_messages),
        "remainingInputTokens": remaining_budget,
    }


system_message = {
    "role": "system",
    "content": "你是星河零售公司的退款审核助手，只根据已提供的信息判断。",
}

summary_message = {
    "role": "system",
    "content": "历史摘要：用户正在处理订单 A1024，退款申请人为小明，退款金额为 3000 元。",
}

history_turns = [
    [
        {
            "role": "user",
            "content": "帮我介绍一下公司的退款流程，并给出每个环节的负责人。",
        },
        {
            "role": "assistant",
            "content": (
                "退款流程包括提交申请、规则校验、订单核对、人工审核和原路退款。"
                "不同退款类型会进入不同处理环节。"
            ),
        },
    ],
    [
        {
            "role": "user",
            "content": "订单 A1024 的退款金额是 3000 元。",
        },
        {
            "role": "assistant",
            "content": "已记录订单 A1024 的退款金额为 3000 元。",
        },
    ],
    [
        {
            "role": "user",
            "content": "退款金额超过 2000 元时，需要人工审核。",
        },
        {
            "role": "assistant",
            "content": "已记录该退款审核规则。",
        },
    ],
]

user_message = {
    "role": "user",
    "content": "订单 A1024 是否需要人工审核？只回答结论和依据。",
}


def run_demo() -> dict[str, Any]:
    """计算完整输入与裁剪后输入的预算数据。"""
    all_messages = [
        system_message,
        summary_message,
        *(message for turn in history_turns for message in turn),
        user_message,
    ]
    all_messages_tokens = estimate_messages_tokens(all_messages)
    result = build_context(
        system_message=system_message,
        summary_message=summary_message,
        history_turns=history_turns,
        user_message=user_message,
    )

    print("本次 Context Budget 分配结果：")
    pprint(
        {
            "模型窗口": MODEL_CONTEXT_LIMIT,
            "输出预留": OUTPUT_RESERVE,
            "外部上下文预留": EXTERNAL_CONTEXT_RESERVE,
            "本次输入预算": result["inputBudget"],
            "全部发送需要Token": all_messages_tokens,
            "裁剪后实际输入Token": result["usedInputTokens"],
            "剩余输入预算": result["remainingInputTokens"],
            "保留历史轮数": len(result["selectedTurns"]),
            "移出历史轮数": len(result["discardedTurns"]),
        },
        sort_dicts=False,
    )
    print("\n最终准备发送给模型的 messages：")
    pprint(result["messages"], sort_dicts=False)
    print("\n本次没有发送的旧历史：")
    pprint(result["discardedTurns"], sort_dicts=False)

    return {**result, "allMessagesTokens": all_messages_tokens}


if __name__ == "__main__":
    run_demo()

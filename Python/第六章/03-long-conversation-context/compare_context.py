"""
对比长对话上下文的三种处理策略。

1. 完整保留历史消息；
2. 直接裁剪，只保留近期消息；
3. 将早期历史压缩成摘要，再拼接近期消息。
"""

from __future__ import annotations

import re

from context import (
    create_expected_compacted_context,
    create_long_conversation,
    includes_fact,
    measure_context,
    message_text,
    message_type,
    trim_to_recent_messages,
)


def short_text(text: str, limit: int = 110) -> str:
    """把多行文本压缩成便于终端观察的一行。"""

    return re.sub(r"\s+", " ", text).strip()[:limit]


def print_strategy(name: str, messages) -> None:
    """打印一种上下文处理方案的规模和关键事实保留情况。"""

    size = measure_context(messages)

    print(f"\n========== {name} ==========")
    print(f"消息数量：{size['messageCount']}")
    print(f"文本字符数：{size['characterCount']}")
    print(f"保留订单号：{includes_fact(messages, 'A2048')}")
    print(f"保留退款金额：{includes_fact(messages, '3800')}")
    print(f"保留缺少照片：{includes_fact(messages, '没有上传破损照片')}")
    print(
        "保留禁止提交："
        f"{includes_fact(messages, '不要替我提交') or includes_fact(messages, '禁止直接提交')}"
    )

    for index, message in enumerate(messages, start=1):
        print(
            f"{index:>2}. {message_type(message):<8} "
            f"{short_text(message_text(message), 110)}"
        )


def main() -> None:
    # 构造一份较长的模拟对话历史。
    full_history = create_long_conversation()

    # 方案二：裁剪历史，只保留最近的一部分消息。
    trimmed_history = trim_to_recent_messages(full_history)

    # 方案三：将较早的历史压缩为摘要，并保留近期原始消息。
    compacted_history = create_expected_compacted_context(full_history)

    # 分别输出三种方案，方便进行直观对比。
    print_strategy("方案一：完整历史", full_history)
    print_strategy("方案二：只保留近期消息", trimmed_history)
    print_strategy("方案三：摘要 + 近期消息", compacted_history)


if __name__ == "__main__":
    main()

"""
长对话上下文处理的公共函数。

本文件对应 Node 版的 context.js，保留三个核心能力：

- 构造一段包含关键事实和无关闲聊的长对话；
- 按消息数量估算上下文规模并裁剪近期消息；
- 构造“摘要 + 近期消息”的确定性压缩结果。

本节统计的是字符数，不把字符数冒充精确 Token 数量。
"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, trim_messages


def create_long_conversation() -> list[BaseMessage]:
    """创建本节统一使用的长对话。

    关键订单信息出现在最前面，
    中间故意加入了与当前问题无关的话题。
    """

    return [
        HumanMessage(
            content=(
                "订单 A2048 是一台 3800 元的咖啡机，外壳破损。"
                "我还没有上传破损照片，客服说超过 3000 元需要人工审核。"
                "请只告诉我处理流程，不要替我提交退款。"
            )
        ),
        AIMessage(
            content=(
                "我记住了。当前订单是 A2048，金额 3800 元，"
                "还缺少破损照片，并且不要直接提交退款。"
            )
        ),
        HumanMessage(content="你们周末几点营业？"),
        AIMessage(content="周末客服在线时间是 9:00 到 18:00。"),
        HumanMessage(content="电子发票一般多久可以开出来？"),
        AIMessage(content="订单完成后通常可以在订单详情页申请电子发票。"),
        HumanMessage(content="这台咖啡机签收 3 天，外包装还在。"),
        AIMessage(content="收到，我会把签收时间和包装情况一起作为后续判断依据。"),
        HumanMessage(
            content=(
                "根据前面说过的情况，这笔退款要走自动流程还是人工审核？"
                "现在还缺什么材料？不要替我提交。"
            )
        ),
    ]


def message_text(message: BaseMessage | Any) -> str:
    """返回 Message 中便于展示和比较的纯文本。"""

    content = getattr(message, "content", "")

    if isinstance(content, str):
        return content

    return json.dumps(content, ensure_ascii=False)


def message_type(message: BaseMessage | Any) -> str:
    """返回 Message 类型，便于和 Node 版 getType() 的展示效果对应。"""

    if hasattr(message, "type"):
        return str(message.type)

    if hasattr(message, "get_type"):
        return str(message.get_type())

    return type(message).__name__


def measure_context(messages: list[BaseMessage]) -> dict[str, int]:
    """估算当前输入的文本规模。"""

    return {
        "messageCount": len(messages),
        "characterCount": sum(len(message_text(message)) for message in messages),
    }


def trim_to_recent_messages(
    messages: list[BaseMessage],
    keep_messages: int = 5,
) -> list[BaseMessage]:
    """只保留最近的几条 Message。

    为了让实验不依赖具体模型的 Tokenizer，
    这里按消息数量裁剪。
    """

    return trim_messages(
        messages,
        strategy="last",
        max_tokens=keep_messages,
        token_counter=lambda current_messages: len(current_messages),
        start_on="human",
    )


def create_expected_compacted_context(messages: list[BaseMessage]) -> list[BaseMessage]:
    """构造“摘要 + 近期消息”的预期结果，用于和直接裁剪做确定性对比。

    真正的自动摘要由 automatic_compaction.py 中的 Middleware 完成。
    """

    recent_messages = trim_to_recent_messages(messages, 5)
    summary = HumanMessage(
        content=(
            "以下是较早对话的摘要：\n"
            "用户咨询订单 A2048：商品是 3800 元的咖啡机，外壳破损，"
            "目前没有上传破损照片。退款金额超过 3000 元，需要人工审核。"
            "用户只要求说明流程，禁止直接提交退款。"
        ),
        additional_kwargs={
            "lc_source": "summarization",
        },
    )

    return [summary, *recent_messages]


def includes_fact(messages: list[BaseMessage], fact: str) -> bool:
    """判断一组 Message 中是否仍然包含指定关键事实。"""

    return any(fact in message_text(message) for message in messages)

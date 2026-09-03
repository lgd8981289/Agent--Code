"""
使用 SummarizationMiddleware 演示长对话自动压缩。

连续使用同一个 thread_id 发起五轮对话。
第五轮进入模型以前，消息数量达到阈值，
Middleware 会压缩较早消息，并把摘要写回 Checkpointer State。
"""

from __future__ import annotations

import os
import sys
from typing import Any

from langchain.agents.middleware import SummarizationMiddleware
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from context import measure_context, message_text


USER_MESSAGES = [
    "订单 A2048 是一台 3800 元的咖啡机，外壳破损。我还没有上传破损照片，客服说超过 3000 元需要人工审核。请只告诉我处理流程，不要替我提交退款。",
    "你们周末几点营业？",
    "电子发票一般多久可以开出来？",
    "这台咖啡机签收 3 天，外包装还在。",
    "根据前面说过的情况，这笔退款要走自动流程还是人工审核？现在还缺什么材料？不要替我提交。",
]


class ChineseSummarizationMiddleware(SummarizationMiddleware):
    """给 Python 内置摘要 Middleware 增加中文摘要前缀。

    LangChain Python 的 SummarizationMiddleware 默认会生成英文包装语：

       Here is a summary of the conversation to date:

    为了让课程输出和 Node 版的 summaryPrefix 保持一致，
    这里只覆盖最终写回 State 的摘要 Message 外壳，
    摘要触发、保留消息数量和摘要模型调用仍然交给内置 Middleware。
    """

    def __init__(self, *args: Any, summary_prefix: str, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.summary_prefix = summary_prefix

    def _build_new_messages(self, summary: str) -> list[HumanMessage]:
        return [
            HumanMessage(
                content=f"{self.summary_prefix}\n{summary}",
                additional_kwargs={
                    "lc_source": "summarization",
                },
            )
        ]


def create_model():
    """创建当前小节使用的 DeepSeek Chat Model。"""

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


def create_compaction_agent(model: Any):
    """创建具备自动摘要能力的短期记忆 Agent。"""

    try:
        from langchain.agents import create_agent
    except ImportError as exc:
        raise RuntimeError("缺少 langchain 依赖，请先执行：python -m pip install -e .") from exc

    return create_agent(
        model=model,
        tools=[],
        checkpointer=InMemorySaver(),
        system_prompt="""你是企业售后客服。
只能使用当前 State 中的消息回答，不得猜测订单信息。
不能替用户提交退款，只能说明判断结果和还缺少的材料。""",
        middleware=[
            ChineseSummarizationMiddleware(
                model,
                trigger=("messages", 8),
                keep=("messages", 5),
                summary_prefix="以下是较早对话的摘要：",
                summary_prompt="""请压缩下面的售后对话。
必须保留已经确认的订单号、金额、商品、问题、材料状态、审核规则、用户限制和未解决事项。
不要把猜测写成事实，不要保留与当前售后问题无关的闲聊。
只输出摘要正文。

{messages}""",
            )
        ],
    )


def find_summary_message(messages: list[Any]) -> Any | None:
    """查找由摘要 Middleware 写入 State 的摘要 Message。"""

    for message in messages:
        if getattr(message, "additional_kwargs", {}).get("lc_source") == "summarization":
            return message

    return None


def print_round(round_number: int, state: dict[str, Any]) -> None:
    """打印每轮结束后 Checkpointer 中保存的最新 State。"""

    messages = state["messages"]
    size = measure_context(messages)
    summary = find_summary_message(messages)

    print(f"\n========== 第 {round_number} 轮结束 ==========")
    print(f"State 消息数量：{size['messageCount']}")
    print(f"State 文本字符数：{size['characterCount']}")
    print(f"是否已经生成摘要：{'是' if summary else '否'}")

    if summary:
        print("\n自动摘要：")
        print(message_text(summary))

    print("\n本轮回答：")
    print(message_text(messages[-1]))


def run_conversation(agent: Any, user_messages: list[str] = USER_MESSAGES) -> list[dict[str, Any]]:
    """连续使用同一个 thread_id 发起多轮对话。"""

    config = {
        "configurable": {
            "thread_id": "long-conversation-1001",
        }
    }
    states = []

    for index, content in enumerate(user_messages, start=1):
        state = agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": content,
                    }
                ]
            },
            config,
        )

        print_round(index, state)
        states.append(state)

    return states


def main() -> None:
    model = create_model()
    agent = create_compaction_agent(model)
    run_conversation(agent)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        raise

import json
import os
from typing import Any

from langchain_core.tools import tool


"""
LangChain Python 最小 Agent。

本节只关注一件事：
把一个普通 Python 函数包装成 Tool，然后交给 LangChain Agent 使用。

Agent 真正运行时会经历：
用户问题 → 模型决策 → Tool 调用 → Tool 结果回注 → 模型生成最终回答。
"""


@tool
def get_order_status(order_id: str) -> str:
    """根据订单号查询当前处理状态。"""

    # 模拟订单系统返回的查询结果。
    return json.dumps(
        {
            "orderId": order_id,
            "status": "waiting_for_manual_review",
            "message": "退款金额超过 2000 元，正在等待人工审核",
        },
        ensure_ascii=False,
    )


def create_model():
    """创建 DeepSeek Chat Model。

    Python 版本不自动读取 .env 文件。
    如果你希望从 .env 中加载变量，需要先在终端中手动 source。
    """

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
    )


def create_customer_service_agent(model: Any | None = None):
    """创建 Agent，并注册可以使用的 Tool。

    create_agent 会负责 Agent Loop：
    模型决策 → Tool 调用 → Tool 结果回注 → 模型继续决策 → 最终回答。
    """

    try:
        from langchain.agents import create_agent
    except ImportError as exc:
        raise RuntimeError("缺少 langchain 依赖，请先执行：python -m pip install -e .") from exc

    return create_agent(
        model=model or create_model(),
        tools=[get_order_status],
        system_prompt="你是订单客服，只能根据工具返回的数据回答。",
    )


def final_message_text(result: dict[str, Any]) -> str:
    """从 Agent 返回结果中取出最后一条消息文本。"""

    messages = result["messages"]
    final_message = messages[-1]

    if isinstance(final_message, dict):
        content = final_message.get("content")
    else:
        content = getattr(final_message, "content")

    if isinstance(content, str):
        return content

    return json.dumps(content, ensure_ascii=False)


def run_agent(question: str = "查询订单 A1024 当前的处理状态") -> str:
    """启动一次 Agent Run。"""

    agent = create_customer_service_agent()

    result = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": question,
                }
            ]
        }
    )

    # messages 中保存了本次 Agent Run 的消息轨迹，
    # 最后一条消息就是 Agent 最终生成的回答。
    return final_message_text(result)


def main() -> None:
    print(run_agent())


if __name__ == "__main__":
    main()

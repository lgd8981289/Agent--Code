"""演示确定性业务代码与大模型表达能力的边界。"""

import json
import os
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


orders = {
    "A1024": {
        "orderId": "A1024",
        "refundAmount": 3000,
        "status": "refund_requested",
    }
}

MANUAL_REVIEW_THRESHOLD = 2000
ChatRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def query_order(order_id: str) -> dict[str, Any] | None:
    """使用本地数据模拟订单查询。"""
    return orders.get(order_id)


def evaluate_refund(order: dict[str, Any]) -> dict[str, Any]:
    """用确定性业务规则计算退款审核结论。"""
    needs_manual_review = order["refundAmount"] > MANUAL_REVIEW_THRESHOLD
    return {
        "orderId": order["orderId"],
        "refundAmount": order["refundAmount"],
        "threshold": MANUAL_REVIEW_THRESHOLD,
        "needsManualReview": needs_manual_review,
        "conclusion": "需要人工审核" if needs_manual_review else "无需人工审核",
    }


def request_chat_completion(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """使用标准库调用 DeepSeek Chat Completions API。"""
    request = Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        error_text = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"DeepSeek API 调用失败：{error.code} {error_text}"
        ) from error


def generate_customer_message(
    result: dict[str, Any],
    *,
    api_key: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> str:
    """让模型只负责把已经验证的审核结果改写成自然语言。"""
    resolved_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
    if not resolved_api_key:
        raise RuntimeError("没有检测到 DEEPSEEK_API_KEY，请先在 .env 中配置。")

    response = requester(
        {
            "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你负责把已经验证的退款审核结果改写成一句简洁回复。"
                        "不得修改订单编号、金额、阈值和审核结论，"
                        "也不得声称已经执行退款。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(result, ensure_ascii=False),
                },
            ],
            "max_tokens": 120,
            "temperature": 0.2,
            "stream": False,
            "thinking": {"type": "disabled"},
        },
        resolved_api_key,
    )
    try:
        return response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("DeepSeek API 没有返回可用的回答。") from error


def review_refund(
    order_id: str,
    *,
    api_key: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> dict[str, Any]:
    """先用代码审核退款，再让模型生成面向客户的表达。"""
    order = query_order(order_id)
    if order is None:
        raise ValueError(f"没有找到订单：{order_id}")

    authoritative_result = evaluate_refund(order)
    customer_message = generate_customer_message(
        authoritative_result,
        api_key=api_key,
        requester=requester,
    )
    return {
        "authoritativeResult": authoritative_result,
        "customerMessage": customer_message,
    }


def main() -> int:
    """审核 A1024 并打印最终结果。"""
    try:
        print(review_refund("A1024"))
    except (RuntimeError, ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

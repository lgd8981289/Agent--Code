"""模拟企业订单系统。"""

from __future__ import annotations

from typing import Any


orders: dict[str, dict[str, Any]] = {
    "A1024": {
        "orderId": "A1024",
        "status": "delivered",
        "productName": "咖啡机",
        "category": "normal",
        "signedDays": 3,
        "refundAmount": 3000,
    },
    "B2048": {
        "orderId": "B2048",
        "status": "delivered",
        "productName": "冷鲜牛排",
        "category": "fresh",
        "signedDays": 1,
        "refundAmount": 199,
    },
}


async def get_order_by_id(order_id: str) -> dict[str, Any]:
    """查询订单详情。

    这里继续使用内存数据模拟企业订单系统；
    换成真实项目时，通常会改成数据库、HTTP 或 RPC 调用。
    """

    order = orders.get(order_id)

    if not order:
        return {
            "ok": False,
            "error": {
                "code": "ORDER_NOT_FOUND",
                "message": f"没有找到订单 {order_id}",
            },
        }

    return {
        "ok": True,
        "order": dict(order),
    }


async def check_refund_eligibility(order_id: str) -> dict[str, Any]:
    """根据售后规则做退款预检。

    这类确定性规则不需要交给模型判断；
    MCP Tool 只负责把业务系统能力标准化暴露出去。
    """

    result = await get_order_by_id(order_id)

    if not result["ok"]:
        return result

    order = result["order"]

    if order["category"] == "fresh":
        return {
            "ok": True,
            "eligible": False,
            "manualReview": False,
            "reason": "生鲜商品不支持无理由退款。",
        }

    if order["signedDays"] > 7:
        return {
            "ok": True,
            "eligible": False,
            "manualReview": False,
            "reason": f"订单已签收 {order['signedDays']} 天，超过 7 天退款期限。",
        }

    if order["refundAmount"] > 2000:
        return {
            "ok": True,
            "eligible": True,
            "manualReview": True,
            "reason": f"退款金额 {order['refundAmount']} 元，超过 2000 元，需要人工审核。",
        }

    return {
        "ok": True,
        "eligible": True,
        "manualReview": False,
        "reason": "订单满足自动退款条件。",
    }


"""模拟企业内部订单系统。"""

from __future__ import annotations

from typing import Any


# 使用 dict 模拟企业内部的订单数据存储。
# key 为订单号，value 为订单的详细信息。
orders: dict[str, dict[str, Any]] = {
    "A1024": {
        "orderId": "A1024",
        "status": "delivered",
        "productName": "咖啡机",
        "refundAmount": 3000,
    }
}


async def get_order_by_id(order_id: str) -> dict[str, Any]:
    """根据订单号查询订单信息。

    这里用内存中的 dict 模拟真实企业订单系统；
    实际项目中通常会调用数据库、HTTP 接口或 RPC 服务。
    """

    # 根据订单号查询对应的订单数据。
    order = orders.get(order_id)

    # 没有查询到订单时，返回统一的失败结果。
    if not order:
        return {
            "ok": False,
            "error": {
                "code": "ORDER_NOT_FOUND",
                "message": f"没有找到订单 {order_id}",
            },
        }

    # 查询成功后返回订单信息。
    # 使用 dict(...) 复制一份对象，避免外部代码直接修改原始数据。
    return {
        "ok": True,
        "order": dict(order),
    }


"""提供 Rerank 和 Context Compression 演示使用的候选资料。"""

from typing import Any


# 用户的初始问题。
question = "订单 A1024 的咖啡机退款 3500 元，系统能否直接通过审核？"

# 这些数据用来模拟检索器已经找回的候选资料。
candidates: list[dict[str, Any]] = [
    {
        "id": "chunk-order-review",
        "title": "订单审核系统说明",
        "retrievalScore": 0.92,
        "content": (
            "订单审核系统会自动检查订单号、商品金额和账户状态。"
            "系统检查完成后会返回处理结果。"
            "运营人员可以在后台查看订单 A1024 的审核记录。"
        ),
    },
    {
        "id": "chunk-refund-threshold",
        "title": "退款金额审核规则",
        "retrievalScore": 0.89,
        "content": (
            "普通商品签收后 7 天内可以申请退款。"
            "退款金额超过 2000 元时，订单必须转入人工审核，系统不得直接通过。"
            "人工审核通常会在 1 个工作日内完成。"
        ),
    },
    {
        "id": "chunk-coffee-machine-service",
        "title": "咖啡机延保服务",
        "retrievalScore": 0.86,
        "content": (
            "咖啡机属于小家电，发货前会进行通电检测。"
            "订单金额达到 3500 元时，可以获得两年延保服务。"
            "延保不包含人为损坏。"
        ),
    },
    {
        "id": "chunk-auto-review",
        "title": "自动审核适用范围",
        "retrievalScore": 0.83,
        "content": (
            "自动审核仅适用于退款金额不超过 2000 元且未触发风控的订单。"
            "超过金额门槛后，退款申请会进入人工审核队列。"
            "客服可以在后台查看审核进度。"
        ),
    },
    {
        "id": "chunk-invoice-a1024",
        "title": "订单 A1024 发票记录",
        "retrievalScore": 0.8,
        "content": (
            "订单 A1024 已开具电子发票，商品名称为咖啡机，含税金额为 3500 元。"
            "如需修改发票抬头，请联系财务人员。"
        ),
    },
    {
        "id": "chunk-refund-arrival",
        "title": "退款到账时间",
        "retrievalScore": 0.77,
        "content": (
            "退款审核通过后，款项会在 3 到 5 个工作日内原路退回。"
            "不同银行的到账时间可能存在差异。"
        ),
    },
]

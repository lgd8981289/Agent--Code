"""提供 RAG 评估使用的固定测试案例。"""

from typing import Any


# 这组数据不是用来训练模型，而是用来评估 RAG。
#
# 每个案例都包含：
# 1. 用户问题
# 2. 人工标注的相关 Chunk ID
# 3. 当前检索器实际返回的排序结果
# 4. RAG 最终生成的答案
#
# 三个案例分别模拟：召回不足、排序靠后和答案幻觉。
evaluation_cases: list[dict[str, Any]] = [
    {
        "id": "recall-miss",
        "name": "召回不完整",
        "question": "订单 A1024 的咖啡机退款 3500 元，系统能否直接通过审核？",

        # 当前问题需要两份规则共同支持。
        "relevantChunkIds": ["chunk-refund-threshold", "chunk-auto-review"],

        # Top3 只找回了一份相关资料。
        "retrievedChunks": [
            {
                "id": "chunk-refund-threshold",
                "title": "退款金额审核规则",
                "content": (
                    "退款金额超过 2000 元时，订单必须转入人工审核，"
                    "系统不得直接通过。"
                ),
            },
            {
                "id": "chunk-invoice-a1024",
                "title": "订单 A1024 发票记录",
                "content": (
                    "订单 A1024 已开具电子发票，商品名称为咖啡机，"
                    "含税金额为 3500 元。"
                ),
            },
            {
                "id": "chunk-order-review",
                "title": "订单审核系统说明",
                "content": "订单审核系统会自动检查订单号、商品金额和账户状态。",
            },
        ],
        "answer": (
            "退款金额 3500 元超过 2000 元，订单必须转入人工审核，"
            "系统不能直接通过。"
        ),
    },
    {
        "id": "ranking-low",
        "name": "相关资料排序靠后",
        "question": "规则编号 BW-RF-2026 对应什么规则？",
        "relevantChunkIds": ["chunk-rule-map"],
        "retrievedChunks": [
            {
                "id": "chunk-rule-guide",
                "title": "售后规则查询说明",
                "content": (
                    "用户提供规则编号后，客服可以查询对应的售后规则名称"
                    "和适用范围。"
                ),
            },
            {
                "id": "chunk-refund-threshold",
                "title": "退款金额审核规则",
                "content": "退款金额超过 2000 元时，需要进入人工审核流程。",
            },
            {
                "id": "chunk-rule-map",
                "title": "规则编号映射表",
                "content": "内部规则映射：BW-RF-2026 对应蓝鲸退款规则。",
            },
        ],
        "answer": "BW-RF-2026 对应蓝鲸退款规则。",
    },
    {
        "id": "answer-hallucination",
        "name": "答案增加了资料中没有的内容",
        "question": "退款审核通过后，多久能退回银行卡？",
        "relevantChunkIds": ["chunk-refund-arrival"],
        "retrievedChunks": [
            {
                "id": "chunk-refund-arrival",
                "title": "退款到账时间",
                "content": (
                    "退款审核通过后，款项会在 3 到 5 个工作日内原路退回。"
                    "不同银行的到账时间可能存在差异。"
                ),
            },
            {
                "id": "chunk-refund-workflow",
                "title": "人工审核流程",
                "content": "客服审核通过后，系统会进入退款打款流程。",
            },
            {
                "id": "chunk-invoice-policy",
                "title": "发票开具规则",
                "content": "订单完成后，用户可以在订单详情页申请电子发票。",
            },
        ],

        # 前半句有资料支持，后半句“保证 24 小时到账”没有任何依据。
        "answer": (
            "退款审核通过后，款项会在 3 到 5 个工作日内原路退回，"
            "并且系统保证 24 小时内到账。"
        ),
    },
]

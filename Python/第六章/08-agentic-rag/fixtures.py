"""Agentic RAG 示例使用的固定数据。

这些数据用来模拟一个企业知识库：

- principal 表示当前登录用户所属租户；
- scenarios 表示课程中可以直接运行的几个问题；
- knowledge_chunks 表示检索系统可能返回的知识片段。

真实项目里，这些内容通常来自用户系统、订单系统、向量库或全文检索服务。
本节为了突出 Agentic RAG 流程，先用内存数据替代外部系统。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


principal: dict[str, str] = {
    "tenantId": "bluewhale",
    "userId": "user-1001",
}


# 固定当前时间，避免课程示例因为真实日期变化导致验证结果不稳定。
now = datetime.fromisoformat("2026-09-08T12:00:00+08:00")


scenarios: dict[str, dict[str, str]] = {
    "direct": {
        "question": "把“请尽快处理退款”改写得更礼貌。",
    },
    "single": {
        "question": "蓝鲸科技现在的退款金额超过多少元需要人工审核？",
    },
    "multi": {
        "question": "订单 A2026 的咖啡机退款金额是 3500 元，需要人工审核吗？准备材料时还要注意什么？",
    },
    "clarify": {
        "question": "我的咖啡机想申请退款，需要人工审核吗？",
    },
    "unknown": {
        "question": "蓝鲸科技的咖啡机是否提供终身免费上门保养？",
    },
}


knowledge_chunks: list[dict[str, Any]] = [
    {
        "id": "KB-REFUND-REVIEW-V3",
        "tenantId": "bluewhale",
        "evidenceType": "review_rule",
        "title": "退款人工审核规则",
        "content": "自 2026 年 9 月 1 日起，退款金额超过 2000 元时必须进入人工审核。",
        "status": "active",
        "version": 3,
        "effectiveAt": "2026-09-01T00:00:00+08:00",
        "expiresAt": None,
    },
    {
        "id": "KB-REFUND-MATERIAL-V2",
        "tenantId": "bluewhale",
        "evidenceType": "material_requirement",
        "title": "咖啡机退款材料说明",
        "content": "咖啡机退款需要提供订单号和清晰的机器序列号照片；商品存在质量问题时，还需要补充问题照片或视频。",
        "status": "active",
        "version": 2,
        "effectiveAt": "2026-08-20T00:00:00+08:00",
        "expiresAt": None,
    },
    {
        "id": "KB-REFUND-ARRIVAL-V1",
        "tenantId": "bluewhale",
        "evidenceType": "arrival_rule",
        "title": "退款到账时间",
        "content": "退款审核通过后，原路退回通常需要 1 至 3 个工作日。",
        "status": "active",
        "version": 1,
        "effectiveAt": "2026-07-01T00:00:00+08:00",
        "expiresAt": None,
    },
    {
        "id": "KB-MAINTENANCE-OLD",
        "tenantId": "bluewhale",
        "evidenceType": "maintenance_policy",
        "title": "旧版咖啡机保养说明",
        "content": "部分咖啡机曾参与免费上门保养活动。",
        "status": "superseded",
        "version": 1,
        "effectiveAt": "2025-01-01T00:00:00+08:00",
        "expiresAt": None,
    },
    {
        "id": "OTHER-TENANT-REFUND",
        "tenantId": "galaxy-retail",
        "evidenceType": "review_rule",
        "title": "星河零售退款规则",
        "content": "退款金额超过 5000 元时进入人工审核。",
        "status": "active",
        "version": 4,
        "effectiveAt": "2026-09-01T00:00:00+08:00",
        "expiresAt": None,
    },
]

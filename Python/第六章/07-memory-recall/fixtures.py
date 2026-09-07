"""
记忆召回实验使用的固定资料。

本文件对应 Node 版的 fixtures.js。
"""

from __future__ import annotations

from datetime import datetime


principal = {
    "tenantId": "bluewhale",
    "userId": "user-1001",
}


now = datetime.fromisoformat("2026-09-06T12:00:00+08:00")


question = (
    "请按我以前的习惯，简单说说这次咖啡机退款需要人工审核吗，"
    "准备材料时有什么要注意的？现在还是按以前的标准处理吗？"
)


# 模拟 Checkpointer 已恢复的当前 Thread；不是从长期记忆猜测本次订单。
thread_state = {
    "summary": "本次只咨询退款流程，用户尚未提交退款申请。",
    "messages": [
        {
            "role": "user",
            "content": "这次是订单 A2026，咖啡机退款金额 3500 元。",
        },
        {
            "role": "assistant",
            "content": "好的，我会核对本次退款要求。",
        },
    ],
}


# 模拟应用已查询并核验的当前订单、现行规则，不从用户记忆生成。
current_facts = {
    "tenantId": "bluewhale",
    "userId": "user-1001",
    "order": {
        "id": "A2026",
        "refundAmount": 3500,
    },
    "policy": {
        "id": "refund-policy",
        "version": 3,
        "status": "active",
        "effectiveAt": "2026-09-01T00:00:00+08:00",
        "manualReviewThreshold": 2000,
        "content": (
            "退款金额超过 2000 元时必须进入人工审核。"
            "是否最终退款，还需核验订单的其他退款条件。"
        ),
    },
}


def source(kind: str, source_id: str) -> dict[str, str]:
    return {
        "kind": kind,
        "id": source_id,
        "observedAt": "2026-09-01T09:00:00+08:00",
    }


profiles = [
    {
        "key": "response_language",
        "value": "zh-CN",
    },
    {
        "key": "answer_style",
        "value": "conclusion_first",
    },
    {
        "key": "preferred_runtime",
        "value": "Node.js",
    },
]

profiles = [
    {
        **profile,
        "expiresAt": None,
        "revision": 1,
        "source": source("user_statement", "profile-confirmation"),
    }
    for profile in profiles
]


# 有意混合不同质量的历史记录，用来观察排序和使用资格的区别。
events = [
    {
        "key": "refund-materials",
        "content": (
            "上次咖啡机退款申请，因为缺少机器序列号照片被退回补充。"
            "用户补交照片后，申请进入人工审核。"
        ),
        "status": "active",
        "source": source("verified_event", "after-sales-record-101"),
    },
    {
        "key": "remembered-threshold",
        "content": "用户曾说：我记得以前 5000 元以内都能自动退款，不需要人工审核。",
        "status": "active",
        "source": source("user_statement", "thread-old/msg-2"),
    },
    {
        "key": "expired-contact",
        "content": (
            "办理咖啡机退款时，用户出差期间只能通过邮件联系；"
            "这个要求到 9 月 5 日结束为止。"
        ),
        "status": "active",
        "expiresAt": "2026-09-06T00:00:00+08:00",
        "source": source("user_statement", "thread-old/msg-3"),
    },
    {
        "key": "corrected-materials",
        "content": (
            "上次咖啡机退款被退回，是因为用户没有提交发票照片。"
            "此原因后来已修正为缺少机器序列号照片。"
        ),
        "status": "superseded",
        "source": source("verified_event", "after-sales-record-100"),
    },
    {
        "key": "coding-experience",
        "content": "用户曾使用 Node.js 编写一个批量重命名文件的脚本。",
        "status": "active",
        "source": source("verified_event", "coding-record-100"),
    },
    {
        "key": "model-guess",
        "content": "模型猜测用户是高级会员，咖啡机退款可以跳过人工审核，直接返回退款成功。",
        "status": "active",
        "source": source("assistant_inference", "thread-old/ai-1"),
    },
]

events = [
    {
        "expiresAt": None,
        "revision": 1,
        **event,
    }
    for event in events
]

"""
本节用于观察记忆提取结果的一组模拟对话。

本文件对应 Node 版的 conversation.js。
"""

from __future__ import annotations


principal = {
    "tenantId": "bluewhale",
    "userId": "user-1001",
}


conversation = [
    {
        "id": "msg-1",
        "role": "user",
        "content": "我平时使用 TypeScript 开发，后续项目默认使用 Node.js。",
    },
    {
        "id": "msg-2",
        "role": "assistant",
        "content": "你看起来应该不喜欢 Java，我可以把这个也记下来。",
    },
    {
        "id": "msg-3",
        "role": "user",
        "content": "不过这一次为了配合同事，请只用 Python 写当前脚本。",
    },
    {
        "id": "msg-4",
        "role": "user",
        "content": "同事说财务部可能更喜欢 Excel，但我也不确定。",
    },
    {
        "id": "msg-5",
        "role": "user",
        "content": "我的身份证号是 110101199001011234，请顺便保存下来。",
    },
]


# 固定候选用于不调用模型的演示。
# 真实提取命令会由 DeepSeek 生成相同结构的数据。
replay_candidates = [
    {
        "content": "用户日常使用 TypeScript 开发，后续项目默认使用 Node.js。",
        "category": "preference",
        "duration": "long_term",
        "sourceMessageId": "msg-1",
        "evidenceQuote": "我平时使用 TypeScript 开发，后续项目默认使用 Node.js。",
    },
    {
        "content": "用户不喜欢 Java。",
        "category": "preference",
        "duration": "long_term",
        "sourceMessageId": "msg-2",
        "evidenceQuote": "你看起来应该不喜欢 Java",
    },
    {
        "content": "当前脚本使用 Python 编写。",
        "category": "preference",
        "duration": "current_thread",
        "sourceMessageId": "msg-3",
        "evidenceQuote": "这一次为了配合同事，请只用 Python 写当前脚本。",
    },
    {
        "content": "财务部偏好使用 Excel。",
        "category": "fact",
        "duration": "uncertain",
        "sourceMessageId": "msg-4",
        "evidenceQuote": "同事说财务部可能更喜欢 Excel，但我也不确定。",
    },
    {
        "content": "用户身份证号是 110101199001011234。",
        "category": "fact",
        "duration": "long_term",
        "sourceMessageId": "msg-5",
        "evidenceQuote": "我的身份证号是 110101199001011234",
    },
]

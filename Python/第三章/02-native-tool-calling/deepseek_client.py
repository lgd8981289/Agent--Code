"""DeepSeek Chat Completions 客户端。"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


# DeepSeek Chat Completions 接口地址。
#
# 可以通过环境变量切换到：
# - DeepSeek 官方接口
# - 企业内部代理接口
# - 兼容 OpenAI 协议的网关服务
API_URL = os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/chat/completions"

# 当前使用的模型。
#
# 通过环境变量配置模型名称，
# 没有配置时使用默认模型。
MODEL = os.getenv("DEEPSEEK_MODEL") or "deepseek-v4-flash"

Requester = Callable[[str, dict[str, Any], str], tuple[int, dict[str, Any]]]


def request_deepseek_json(
    api_url: str, request_body: dict[str, Any], api_key: str
) -> tuple[int, dict[str, Any]]:
    """使用 Python 标准库发送 HTTP 请求。"""

    request = Request(
        api_url,
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        error_text = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(error_text)
        except json.JSONDecodeError:
            return error.code, {"message": error_text}


def call_deepseek(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    requester: Requester = request_deepseek_json,
) -> dict[str, Any]:
    """调用 DeepSeek 模型。

    messages：
    当前对话消息，包括用户问题、模型消息和工具执行结果。

    tools：
    提供给模型的工具定义。模型会根据工具说明判断是否发起工具调用。
    """

    # 调用模型前先检查 API Key，避免发送无效请求。
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。")

    # 记录请求开始时间，用于统计模型接口耗时。
    started_at = time.perf_counter()

    status, data = requester(
        API_URL,
        {
            "model": MODEL,

            # 当前完整对话上下文。
            "messages": messages,

            # 将可用工具说明发送给模型。
            "tools": tools,

            # 由模型自动决定：
            # - 直接生成文本回答
            # - 调用某个工具
            "tool_choice": "auto",

            # 当前案例关闭思考模式，让 Tool Calling 流程更加直接。
            "thinking": {
                "type": "disabled",
            },

            # 使用较低温度，减少工具选择和参数生成的随机性。
            "temperature": 0.1,
        },
        api_key,
    )

    if status < 200 or status >= 300:
        raise RuntimeError(
            f"DeepSeek 调用失败：{status} {json.dumps(data, ensure_ascii=False)}"
        )

    # Chat Completions 接口的主要结果位于 choices 数组的第一项。
    choices = data.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else None

    # 防止接口返回成功状态，但响应结构中没有有效模型消息。
    if not choice or not choice.get("message"):
        raise RuntimeError(
            f"DeepSeek 没有返回有效消息：{json.dumps(data, ensure_ascii=False)}"
        )

    return {
        # 模型本轮返回的完整消息。
        #
        # 可能包含：
        # - content：普通文本回答
        # - tool_calls：模型提出的工具调用请求
        "message": choice["message"],

        # 模型停止生成的原因。
        #
        # 常见值包括：
        # - stop：模型已经生成最终回答
        # - tool_calls：模型请求调用工具
        # - length：达到最大输出长度
        "finishReason": choice.get("finish_reason"),

        # 本次模型接口调用的总耗时，单位为毫秒。
        "latencyMs": round((time.perf_counter() - started_at) * 1000),

        # 输入、输出以及总 Token 数量等统计信息。
        "usage": data.get("usage"),
    }


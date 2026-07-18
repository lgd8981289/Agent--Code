"""DeepSeek Chat Completions 客户端。"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


API_URL = os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/chat/completions"

MODEL = os.getenv("DEEPSEEK_MODEL") or "deepseek-v4-flash"

Requester = Callable[[str, dict[str, Any], str], tuple[int, dict[str, Any]]]


def request_deepseek_json(
    api_url: str, request_body: dict[str, Any], api_key: str
) -> tuple[int, dict[str, Any]]:
    """使用 Python 标准库发送 DeepSeek 请求。"""

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
    """调用 DeepSeek Chat Completions。

    Host 会把当前 messages 和由 MCP Tools 转换出的工具说明一起发送给模型。
    """

    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。")

    started_at = time.perf_counter()
    status, data = requester(
        API_URL,
        {
            "model": MODEL,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "thinking": {
                "type": "disabled",
            },
            "temperature": 0.1,
        },
        api_key,
    )

    if status < 200 or status >= 300:
        raise RuntimeError(
            f"DeepSeek 调用失败：{status} {json.dumps(data, ensure_ascii=False)}"
        )

    choices = data.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else None
    if not choice or not choice.get("message"):
        raise RuntimeError(
            f"DeepSeek 没有返回有效消息：{json.dumps(data, ensure_ascii=False)}"
        )

    return {
        "message": choice["message"],
        "finishReason": choice.get("finish_reason"),
        "latencyMs": round((time.perf_counter() - started_at) * 1000),
        "usage": data.get("usage"),
    }


"""执行模型路由器生成的 DeepSeek 调用计划。"""

import json
import os
import time
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ChatRequester = Callable[[dict[str, Any], str], dict[str, Any]]


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


def call_deepseek(
    *,
    route: dict[str, Any],
    messages: list[dict[str, str]],
    api_key: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> dict[str, Any]:
    """根据路线组装请求；没有 API Key 时只返回请求体。"""
    body = {
        "model": route["model"],
        "messages": messages,
        "thinking": route["thinking"],
    }
    if route.get("reasoning_effort"):
        body["reasoning_effort"] = route["reasoning_effort"]

    resolved_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
    if not resolved_api_key:
        return {
            "skipped": True,
            "reason": "未设置 DEEPSEEK_API_KEY，本次只打印请求体。",
            "requestBody": body,
        }

    started_at = time.monotonic()
    data = requester(body, resolved_api_key)
    try:
        message = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("DeepSeek API 没有返回可用的回答。") from error

    return {
        "skipped": False,
        "latencyMs": round((time.monotonic() - started_at) * 1000),
        "content": message.get("content"),
        "reasoningContent": message.get("reasoning_content"),
        "usage": data.get("usage"),
    }

"""演示如何通过 messages 保存多轮对话上下文。"""

import json
import os
from pprint import pprint
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


messages: list[dict[str, str]] = [
    {
        "role": "system",
        "content": (
            "你是星河零售公司的退款审核助手。"
            "回答时只根据当前对话中已经提供的信息判断。"
        ),
    }
]

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


def send_message(
    user_content: str,
    demo_assistant_reply: str,
    *,
    history: list[dict[str, str]] = messages,
    api_key: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> str:
    """发送一轮消息，并把 user/assistant 消息追加到历史记录。"""
    history.append({"role": "user", "content": user_content})

    request_body = {
        "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "messages": history,
        "stream": False,
        "thinking": {"type": "disabled"},
    }

    print("\n本轮准备发送给 DeepSeek API 的 messages：")
    pprint(request_body["messages"], sort_dicts=False)

    resolved_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
    if not resolved_api_key:
        print("\n没有检测到 DEEPSEEK_API_KEY，使用演示回复：")
        print(demo_assistant_reply)
        assistant_content = demo_assistant_reply
    else:
        response = requester(request_body, resolved_api_key)
        try:
            assistant_content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise RuntimeError("DeepSeek API 没有返回可用的回答。") from error

        print("\nDeepSeek 回答：")
        print(assistant_content)
        print("\n本轮 Token 用量：")
        pprint(response.get("usage"), sort_dicts=False)

    history.append({"role": "assistant", "content": assistant_content})
    return assistant_content


def run_demo() -> list[dict[str, str]]:
    """连续执行三轮退款审核对话。"""
    send_message(
        "订单 A1024 的退款金额是 3000 元，是否需要人工审核？",
        "目前缺少退款规则，无法判断是否需要人工审核。",
    )
    send_message(
        "退款金额超过 2000 元时，需要人工审核。",
        "根据刚刚提供的规则，订单 A1024 需要人工审核。",
    )
    send_message(
        "为什么？只回答依据。",
        "因为订单 A1024 的退款金额为 3000 元，超过了 2000 元。",
    )
    return messages


if __name__ == "__main__":
    run_demo()

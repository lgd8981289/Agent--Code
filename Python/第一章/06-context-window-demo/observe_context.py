"""调用 DeepSeek API，观察多轮对话的 Token 用量变化。"""

import json
import os
import sys
from pprint import pprint
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


user_messages = [
    "订单 A1024 的退款金额是 3000 元，是否需要人工审核？",
    "退款金额超过 2000 元时，需要人工审核。",
    "只回答订单编号和最终结论。",
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


def run_demo(
    *,
    api_key: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> dict[str, Any]:
    """执行三轮对话并返回最终历史和每轮响应。"""
    resolved_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
    if not resolved_api_key:
        raise RuntimeError("没有检测到 DEEPSEEK_API_KEY，请先在 .env 中配置。")

    model = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
    messages = [
        {
            "role": "system",
            "content": (
                "你是星河零售公司的退款审核助手。回答必须简洁，"
                "并且只能根据当前对话中已经提供的信息判断。"
            ),
        }
    ]
    responses: list[dict[str, Any]] = []

    for index, user_content in enumerate(user_messages, start=1):
        messages.append({"role": "user", "content": user_content})
        result = requester(
            {
                "model": model,
                "messages": messages,
                "max_tokens": 120,
                "stream": False,
                "thinking": {"type": "disabled"},
            },
            resolved_api_key,
        )

        try:
            choice = result["choices"][0]
            assistant_message = choice["message"]
            usage = result["usage"]
        except (KeyError, IndexError, TypeError) as error:
            raise RuntimeError("DeepSeek API 没有返回完整的对话结果。") from error

        print(f"\n第 {index} 轮")
        print(f"用户：{user_content}")
        print(f"模型：{assistant_message['content']}")
        pprint(
            {
                "输入消息数量": len(messages),
                "输入Token": usage["prompt_tokens"],
                "输出Token": usage["completion_tokens"],
                "总Token": usage["total_tokens"],
                "缓存命中Token": usage.get("prompt_cache_hit_tokens", 0),
                "缓存未命中Token": usage.get("prompt_cache_miss_tokens", 0),
                "停止原因": choice.get("finish_reason"),
            },
            sort_dicts=False,
        )

        messages.append(
            {"role": "assistant", "content": assistant_message["content"]}
        )
        responses.append(result)

    return {"messages": messages, "responses": responses}


def main() -> int:
    """运行示例并把可预期错误转换为清晰提示。"""
    try:
        run_demo()
    except (RuntimeError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

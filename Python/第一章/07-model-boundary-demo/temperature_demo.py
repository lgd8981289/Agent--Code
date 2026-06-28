"""对比低 temperature 与高 temperature 的生成结果。"""

import json
import os
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


prompt = "请为退款审核助手写几句简短的欢迎语，只输出欢迎语。"
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


def run_group(
    temperature: float,
    *,
    api_key: str,
    requester: ChatRequester = request_chat_completion,
) -> list[str]:
    """使用指定 temperature 连续调用三次模型。"""
    print(f"\n===== temperature = {temperature} =====")
    outputs: list[str] = []

    for index in range(1, 4):
        result = requester(
            {
                "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 80,
                "temperature": temperature,
                "stream": False,
                "thinking": {"type": "disabled"},
            },
            api_key,
        )
        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise RuntimeError("DeepSeek API 没有返回可用的回答。") from error

        print(f"{index}. {content}")
        outputs.append(content)

    return outputs


def run_demo(
    *,
    api_key: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> dict[float, list[str]]:
    """分别运行低温度与高温度实验。"""
    resolved_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
    if not resolved_api_key:
        raise RuntimeError("没有检测到 DEEPSEEK_API_KEY，请先在 .env 中配置。")

    return {
        0.1: run_group(0.1, api_key=resolved_api_key, requester=requester),
        1.5: run_group(1.5, api_key=resolved_api_key, requester=requester),
    }


def main() -> int:
    """运行 temperature 对比实验。"""
    try:
        run_demo()
    except (RuntimeError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

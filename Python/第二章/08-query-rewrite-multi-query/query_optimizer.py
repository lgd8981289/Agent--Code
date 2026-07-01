"""演示 Query Rewrite 和 Multi-Query 查询优化。"""

import json
import os
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


# 默认的会话上下文。
# 真实项目中，这部分通常来自用户的历史对话、订单信息、业务系统查询结果等。
DEFAULT_CONTEXT = "用户正在咨询订单 A1024，商品是咖啡机，退款金额为 3500 元。"

# 默认的用户原始问题。
# 这里的用户问题比较口语化，单独看并不完整。
DEFAULT_QUESTION = "这个不想要了。"

# 如果没有配置 CHAT_MODEL，则默认使用 glm-4.7-flash。
DEFAULT_MODEL = "glm-4.7-flash"

ChatRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def build_messages(*, context: str, question: str) -> list[dict[str, str]]:
    """构造符合 Chat Completions 格式的 messages。"""
    return [
        {
            # system 用来告诉模型它的角色、任务和输出规则。
            "role": "system",
            "content": """你是企业知识库的检索问题优化器。

你的任务不是回答用户问题，而是生成更适合知识库检索的查询。

请严格遵守以下规则：
1. rewrittenQuery 必须是一条脱离会话上下文后仍能独立理解的完整问题。
2. multiQueries 必须包含 3 条查询，并且分别从业务规则、判断条件或处理流程等不同检索角度描述同一个需求，不能只是替换近义词。
3. 所有查询必须保留用户的核心意图，不能把“如何处理”改成“处理进度”，也不能改成其他问题。
4. 保留上下文中已经明确的订单号、商品、金额和业务条件。
5. 不得补充上下文中不存在的事实，也不要给出问题答案。
6. 只返回 JSON，格式为：
{"rewrittenQuery":"一条改写后的问题","multiQueries":["查询一","查询二","查询三"]}""",
        },
        {
            # user 中放入真实的输入信息：
            # 1. 会话上下文
            # 2. 用户原始问题
            #
            # 模型需要结合上下文，把口语化、省略信息的问题补全。
            "role": "user",
            "content": f"会话上下文：{context}\n用户原始问题：{question}",
        },
    ]


def validate_result(result: Any) -> dict[str, Any]:
    """校验模型返回的 JSON 结构是否符合预期。"""
    # rewrittenQuery 必须存在，并且必须是字符串。
    if not isinstance(result, dict) or not isinstance(
        result.get("rewrittenQuery"), str
    ):
        raise ValueError("模型返回结果中缺少 rewrittenQuery。")

    # multiQueries 必须满足三个条件：
    # 1. 是列表
    # 2. 长度必须是 3
    # 3. 列表里的每一项都必须是字符串
    multi_queries = result.get("multiQueries")
    if (
        not isinstance(multi_queries, list)
        or len(multi_queries) != 3
        or any(not isinstance(query, str) for query in multi_queries)
    ):
        raise ValueError("模型返回的 multiQueries 必须包含 3 条字符串查询。")

    return result


def request_chat_completion(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """使用 Python 标准库调用智谱 Chat Completions API。"""
    request = Request(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers={
            # 通过 Bearer Token 方式传递 API Key。
            "Authorization": f"Bearer {api_key}",
            # 告诉接口，请求体是 JSON 格式。
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
            f"智谱 API 调用失败：{error.code} {error_text}"
        ) from error


def optimize_query(
    *,
    context: str,
    question: str,
    api_key: str | None = None,
    chat_model: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> dict[str, Any]:
    """调用大模型，生成 rewrittenQuery 和 multiQueries。"""
    # 如果没有配置 API Key，直接抛出错误。
    # 这样可以避免后面调用接口时才出现更难理解的鉴权错误。
    resolved_api_key = (
        api_key if api_key is not None else os.getenv("ZHIPU_API_KEY")
    )
    if not resolved_api_key:
        raise RuntimeError("没有检测到 ZHIPU_API_KEY，请先配置 .env。")

    resolved_model = (
        chat_model
        if chat_model is not None
        else os.getenv("CHAT_MODEL", DEFAULT_MODEL)
    )

    # 调用智谱的 Chat Completions 接口。
    result = requester(
        {
            # 本次调用的模型名称。
            "model": resolved_model,
            # 构造好的 system + user 消息。
            "messages": build_messages(context=context, question=question),
            # 要求模型尽量返回 JSON 对象。
            # 即使设置了这个参数，后面仍然需要自己解析并校验 JSON。
            "response_format": {"type": "json_object"},
            # 温度设置低一点，让查询改写的输出更加稳定。
            "temperature": 0.1,
            # 不使用流式输出，等待模型一次性返回完整结果。
            "stream": False,
        },
        resolved_api_key,
    )

    # Chat Completions 的正文通常位于 choices[0].message.content。
    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("智谱 API 没有返回可用内容。") from error

    if not content:
        raise RuntimeError("智谱 API 没有返回可用内容。")

    try:
        # content 是字符串，需要先解析成 Python 对象，
        # 然后再用 validate_result 校验字段结构。
        return validate_result(json.loads(content))
    except json.JSONDecodeError as error:
        raise ValueError(f"模型没有返回合法 JSON：{content}") from error


def print_result(
    *, context: str, question: str, result: dict[str, Any]
) -> None:
    """把原始输入和模型生成的结果打印到控制台。"""
    print("\n================ 原始输入 ================")
    print(f"会话上下文：{context}")
    print(f"用户问题：{question}")

    print("\n================ Query Rewrite ================")
    print(result["rewrittenQuery"])

    print("\n================ Multi-Query ================")
    for index, query in enumerate(result["multiQueries"], start=1):
        print(f"{index}. {query}")


def main(argv: list[str] | None = None) -> None:
    """读取命令行问题，调用模型并打印查询优化结果。"""
    arguments = sys.argv[1:] if argv is None else argv

    # 从命令行参数中读取用户问题。
    # 如果没有传入问题，则使用默认问题。
    question = " ".join(arguments).strip() or DEFAULT_QUESTION

    # QUERY_CONTEXT 未配置或只有空白字符时，使用默认会话上下文。
    context = (os.getenv("QUERY_CONTEXT") or "").strip() or DEFAULT_CONTEXT
    model = os.getenv("CHAT_MODEL", DEFAULT_MODEL)

    result = optimize_query(
        context=context,
        question=question,
        chat_model=model,
    )

    print(f"本次调用模型：{model}")
    print_result(context=context, question=question, result=result)


if __name__ == "__main__":
    main()

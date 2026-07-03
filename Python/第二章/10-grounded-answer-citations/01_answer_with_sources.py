"""生成带真实 Chunk 来源的 RAG 回答。"""

import json
import os
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


DEFAULT_CHAT_MODEL = "glm-4.7-flash"

# 用户提出的问题。
# 在真实项目中，这个问题一般来自前端输入。
question = "订单 A1024 的咖啡机退款 3500 元，系统能否直接通过审核？"

# 模拟第 09 节经过 Rerank 后留下的最终 Chunk。
#
# source 是文档入库时保存的 Metadata，不是模型生成的。
# 模型只返回 Chunk ID，系统再根据 Chunk ID 找到真实来源，
# 避免模型自己编造来源。
chunks = [
    {
        # Chunk 的唯一标识，模型返回引用来源时需要返回这个 id。
        "id": "chunk-refund-threshold",
        "title": "退款金额审核规则",
        # 入库时保存的来源元数据，用于最终展示信息来源。
        "source": "knowledge/refund-policy.md",
        # 模型只能基于 Chunk 原文回答问题。
        "content": "退款金额超过 2000 元时，订单必须转入人工审核，系统不得直接通过。",
    },
    {
        "id": "chunk-auto-review",
        "title": "自动审核适用范围",
        "source": "knowledge/auto-review-policy.md",
        "content": "自动审核仅适用于退款金额不超过 2000 元且未触发风控的订单。",
    },
]

ChatRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def build_messages(
    question_text: str = question,
    documents: list[dict[str, str]] = chunks,
) -> list[dict[str, str]]:
    """把用户问题和知识库 Chunk 组织成模型消息。"""
    # source 是系统侧用于展示来源的元数据，不传给模型。
    # 模型只需要知道 Chunk 的 id、title 和 content。
    model_chunks = [
        {
            "id": document["id"],
            "title": document["title"],
            "content": document["content"],
        }
        for document in documents
    ]

    return [
        {
            "role": "system",
            "content": """你是企业知识库问答助手。

请只根据用户提供的知识库 Chunk 回答问题。

返回要求：
1. answer 是给用户的最终答案。
2. sourceChunkIds 只填写直接支持答案的 Chunk ID。
3. sourceChunkIds 至少包含一个 ID，不得编造不存在的 ID。
4. 只返回下面结构的 JSON，不要返回其他内容：
{"answer":"最终答案","sourceChunkIds":["Chunk ID"]}""",
        },
        {
            "role": "user",
            "content": (
                f"用户问题：{question_text}\n\n知识库 Chunk：\n"
                f"{json.dumps(model_chunks, ensure_ascii=False, indent=2)}"
            ),
        },
    ]


def request_chat_completion(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """使用 Python 标准库调用智谱 Chat Completions API。"""
    request = Request(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
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
            f"答案生成失败：{error.code} {error_text}"
        ) from error


def call_model(
    *,
    question_text: str = question,
    documents: list[dict[str, str]] = chunks,
    api_key: str | None = None,
    chat_model: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> Any:
    """调用模型，并把字符串形式的 JSON 解析为 Python 对象。"""
    # 调用模型前先确认 API Key 已配置，避免发起无效请求。
    resolved_api_key = (
        api_key if api_key is not None else os.getenv("ZHIPU_API_KEY")
    )
    if not resolved_api_key:
        raise RuntimeError("没有检测到 ZHIPU_API_KEY，请先配置 .env。")

    resolved_model = (
        chat_model
        if chat_model is not None
        else os.getenv("CHAT_MODEL", DEFAULT_CHAT_MODEL)
    )

    result = requester(
        {
            "model": resolved_model,
            "messages": build_messages(question_text, documents),
            # 要求模型返回 JSON 对象，但程序仍需自行解析和校验。
            "response_format": {"type": "json_object"},
            # 当前任务只需依据明确规则回答，不需要复杂推理。
            "thinking": {"type": "disabled"},
            "temperature": 0,
            "stream": False,
        },
        resolved_api_key,
    )

    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("模型没有返回可用内容。") from error

    if not content:
        raise RuntimeError("模型没有返回可用内容。")

    try:
        return json.loads(content)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError(f"模型没有返回合法 JSON：{content}") from error


def attach_sources(
    model_result: Any,
    documents: list[dict[str, str]] = chunks,
) -> dict[str, Any]:
    """根据模型返回的 Chunk ID 绑定系统保存的真实来源。"""
    if not isinstance(model_result, dict):
        raise ValueError("模型没有返回 JSON 对象。")

    answer = model_result.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise ValueError("模型没有返回有效 answer。")

    source_chunk_ids = model_result.get("sourceChunkIds")
    if not isinstance(source_chunk_ids, list) or not source_chunk_ids:
        raise ValueError("模型没有返回有效 sourceChunkIds。")

    # Chunk ID 到原始 Chunk 的映射由系统建立，不依赖模型生成来源信息。
    chunk_map = {document["id"]: document for document in documents}

    # 按模型返回顺序去重，避免重复展示同一个来源。
    unique_chunk_ids: list[str] = []
    for chunk_id in source_chunk_ids:
        if not isinstance(chunk_id, str) or chunk_id not in chunk_map:
            raise ValueError(f"模型引用了不存在的 Chunk ID：{chunk_id}")
        if chunk_id not in unique_chunk_ids:
            unique_chunk_ids.append(chunk_id)

    return {
        "answer": answer.strip(),
        # sources 来自系统保存的 Chunk Metadata，不是模型生成的来源。
        "sources": [chunk_map[chunk_id] for chunk_id in unique_chunk_ids],
    }


def print_answer(
    result: dict[str, Any], question_text: str = question
) -> None:
    """打印用户问题、答案及支持答案的真实来源。"""
    print("================ 带来源的 RAG 回答 ================")
    print(f"用户问题：{question_text}")
    print(f"回答：{result['answer']}")
    print("信息来源：")

    for index, source in enumerate(result["sources"], start=1):
        print(f"\n[{index}] {source['title']}")
        print(f"文件：{source['source']}")
        print(f"Chunk ID：{source['id']}")
        print(f"原文：{source['content']}")


def main() -> None:
    """生成答案、绑定真实来源并打印结果。"""
    model_result = call_model()
    answer_with_sources = attach_sources(model_result)
    print_answer(answer_with_sources)


if __name__ == "__main__":
    main()

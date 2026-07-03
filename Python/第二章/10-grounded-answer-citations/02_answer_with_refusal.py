"""演示知识库证据不足时的 RAG 拒答机制。"""

import json
import os
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


DEFAULT_CHAT_MODEL = "glm-4.7-flash"

# 用户询问咖啡机的免费保修年限。
question = "这台咖啡机可以免费保修几年？"

# 知识库资料不足时，系统统一使用这个拒答内容。
REFUSAL_ANSWER = "根据当前知识库资料，无法回答这个问题。"

# 向量检索可能仍会返回“最接近”的资料，
# 但“最接近”不代表资料真的能够回答问题。
chunks = [
    {
        "id": "chunk-refund-arrival",
        "title": "退款到账时间",
        "source": "knowledge/refund-arrival.md",
        "content": (
            "退款审核通过后，款项会在 3 到 5 个工作日内原路退回。"
            "不同银行的到账时间可能存在差异。"
        ),
    }
]

ChatRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def create_refusal() -> dict[str, Any]:
    """创建不带来源的系统统一拒答结果。"""
    return {
        "status": "insufficient_evidence",
        "answer": REFUSAL_ANSWER,
        "sources": [],
    }


def build_messages(
    question_text: str = question,
    documents: list[dict[str, str]] = chunks,
) -> list[dict[str, str]]:
    """让模型先判断 Chunk 是否能够直接支持问题答案。"""
    # source 是系统侧元数据，不交给模型。
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
            "content": f"""你是企业知识库问答助手，只能根据用户提供的知识库 Chunk 回答问题。

请先判断 Chunk 是否能够直接支持问题的答案。

返回要求：
1. 能够直接支持答案时，status 返回 answered，answer 返回最终答案，sourceChunkIds 返回直接支持答案的 Chunk ID。
2. 无法直接支持答案时，不得使用自己的知识补充或猜测。status 返回 insufficient_evidence，answer 固定返回“{REFUSAL_ANSWER}”，sourceChunkIds 返回空数组。
3. 只返回下面结构的 JSON，不要返回其他内容：
{{"status":"answered 或 insufficient_evidence","answer":"最终答案或拒答内容","sourceChunkIds":["Chunk ID"]}}""",
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
    """调用模型并解析字符串形式的 JSON 结果。"""
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
            "response_format": {"type": "json_object"},
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


def validate_result(
    model_result: Any,
    documents: list[dict[str, str]] = chunks,
) -> dict[str, Any]:
    """校验模型状态、答案、引用 ID，并绑定真实来源。"""
    if not isinstance(model_result, dict):
        raise ValueError("模型没有返回 JSON 对象。")

    status = model_result.get("status")
    if status not in {"answered", "insufficient_evidence"}:
        raise ValueError(f"模型返回了无效 status：{status}")

    source_chunk_ids = model_result.get("sourceChunkIds")
    if not isinstance(source_chunk_ids, list):
        raise ValueError("模型返回的 sourceChunkIds 必须是数组。")

    if status == "insufficient_evidence":
        # 资料不足时不能携带来源，否则拒答状态与证据相互矛盾。
        if source_chunk_ids:
            raise ValueError("拒答结果不应该包含信息来源。")

        # 不使用模型自由生成的拒答文案，统一返回系统定义内容。
        return create_refusal()

    answer = model_result.get("answer")
    if (
        not isinstance(answer, str)
        or not answer.strip()
        or not source_chunk_ids
    ):
        raise ValueError("正常回答必须包含 answer 和 sourceChunkIds。")

    chunk_map = {document["id"]: document for document in documents}
    unique_chunk_ids: list[str] = []
    for chunk_id in source_chunk_ids:
        if not isinstance(chunk_id, str) or chunk_id not in chunk_map:
            raise ValueError(f"模型引用了不存在的 Chunk ID：{chunk_id}")
        if chunk_id not in unique_chunk_ids:
            unique_chunk_ids.append(chunk_id)

    return {
        "status": "answered",
        "answer": answer.strip(),
        "sources": [chunk_map[chunk_id] for chunk_id in unique_chunk_ids],
    }


def generate_answer(
    *,
    question_text: str = question,
    documents: list[dict[str, str]] = chunks,
    api_key: str | None = None,
    chat_model: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> dict[str, Any]:
    """没有候选 Chunk 时直接拒答，否则调用模型判断证据。"""
    if not documents:
        return create_refusal()

    model_result = call_model(
        question_text=question_text,
        documents=documents,
        api_key=api_key,
        chat_model=chat_model,
        requester=requester,
    )
    return validate_result(model_result, documents)


def print_answer(
    result: dict[str, Any],
    *,
    question_text: str = question,
    candidate_count: int | None = None,
) -> None:
    """打印拒答状态、统一答案和来源数量。"""
    resolved_candidate_count = (
        len(chunks) if candidate_count is None else candidate_count
    )
    print("================ RAG 拒答案例 ================")
    print(f"用户问题：{question_text}")
    print(f"候选 Chunk 数量：{resolved_candidate_count}")
    print(f"回答状态：{result['status']}")
    print(f"回答：{result['answer']}")
    print(f"信息来源：{'无' if not result['sources'] else len(result['sources'])}")


def main() -> None:
    """判断证据是否充分，并打印最终回答。"""
    result = generate_answer()
    print_answer(result)


if __name__ == "__main__":
    main()

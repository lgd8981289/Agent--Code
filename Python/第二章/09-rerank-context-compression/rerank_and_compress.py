"""先执行 Rerank，再进行抽取式 Context Compression。"""

import json
import os
import re
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from candidate_documents import candidates, question


DEFAULT_RERANK_MODEL = "rerank"
DEFAULT_CHAT_MODEL = "glm-4.7-flash"

RerankRequester = Callable[[dict[str, Any], str], dict[str, Any]]
ChatRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def post_json(
    url: str,
    request_body: dict[str, Any],
    api_key: str,
    error_name: str,
) -> dict[str, Any]:
    """向指定智谱接口发送 JSON 请求，并统一处理 HTTP 错误。"""
    request = Request(
        url,
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
            f"{error_name}：{error.code} {error_text}"
        ) from error


def request_rerank(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """调用智谱 Rerank API。"""
    return post_json(
        "https://open.bigmodel.cn/api/paas/v4/rerank",
        request_body,
        api_key,
        "Rerank API 调用失败",
    )


def request_chat_completion(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """调用智谱 Chat Completions API。"""
    return post_json(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        request_body,
        api_key,
        "Context Compression 调用失败",
    )


def resolve_api_key(api_key: str | None) -> str:
    """优先使用显式参数，否则从进程环境变量读取 API Key。"""
    resolved_api_key = (
        api_key if api_key is not None else os.getenv("ZHIPU_API_KEY")
    )
    if not resolved_api_key:
        raise RuntimeError("没有检测到 ZHIPU_API_KEY，请先配置 .env。")
    return resolved_api_key


def rerank_documents(
    query: str,
    documents: list[dict[str, Any]],
    top_n: int = 4,
    *,
    api_key: str | None = None,
    rerank_model: str | None = None,
    requester: RerankRequester = request_rerank,
) -> list[dict[str, Any]]:
    """使用专用 Rerank 模型重新计算相关性并排序。"""
    resolved_api_key = resolve_api_key(api_key)
    resolved_model = (
        rerank_model
        if rerank_model is not None
        else os.getenv("RERANK_MODEL", DEFAULT_RERANK_MODEL)
    )

    result = requester(
        {
            "model": resolved_model,
            # 用户原始问题。
            "query": query,
            # 把标题和正文拼成 Rerank 模型需要的字符串数组。
            "documents": [
                f"{document['title']}\n{document['content']}"
                for document in documents
            ],
            "top_n": top_n,
            # 通过 index 从本地 documents 中取回原文。
            "return_documents": False,
            "return_raw_scores": True,
        },
        resolved_api_key,
    )

    results = result.get("results") if isinstance(result, dict) else None
    if not isinstance(results, list):
        raise RuntimeError("Rerank API 没有返回可用的 results。")

    reranked_documents: list[dict[str, Any]] = []
    for item in results:
        index = item.get("index") if isinstance(item, dict) else None
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or index < 0
            or index >= len(documents)
        ):
            raise RuntimeError(f"Rerank API 返回了无效文档下标：{index}")

        reranked_documents.append(
            {
                **documents[index],
                # 附加 Rerank 模型计算出来的相关性分数。
                "rerankScore": item.get("relevance_score"),
            }
        )

    return reranked_documents


def create_sentence_records(
    documents: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """把 Chunk 拆成句子，并为每句话分配稳定 ID。"""
    sentence_records: list[dict[str, str]] = []

    for document in documents:
        # 使用简单正则按中文或英文标点切句，并保留句末标点。
        sentences = [
            item.strip()
            for item in re.findall(r"[^。！？!?]+[。！？!?]?", document["content"])
        ]

        # 记录句子所属 Chunk，后面按原文顺序重新组装上下文。
        for index, text in enumerate(filter(None, sentences), start=1):
            sentence_records.append(
                {
                    "sentenceId": f"{document['id']}-s{index}",
                    "chunkId": document["id"],
                    "text": text,
                }
            )

    return sentence_records


def build_compression_messages(
    query: str, sentence_records: list[dict[str, str]]
) -> list[dict[str, str]]:
    """构造抽取式 Context Compression 使用的 messages。"""
    return [
        {
            "role": "system",
            "content": """你是 RAG 系统中的上下文过滤器。

请从候选句子中，选出能够直接回答用户问题，或者是得出答案所必需的原句。

要求：
1. 只返回句子 ID，不要改写、总结或补充原文。
2. 只选择包含业务规则、判断条件或处理结论，并且能支持当前问题答案的句子。
3. 仅仅重复订单号、商品、金额等用户信息，但不包含处理规则的句子，必须排除。
4. 发票、延保、到账时间、后台记录和处理进度等不能回答当前问题的内容，必须排除。
5. 保留原文中的关键业务条件、阈值和强制性表述。
6. 输出前逐条检查：删除这句话以后，是否仍然能够得出同样的审核结论？如果可以，就不要选择。
7. 只返回 JSON：{"selectedSentenceIds":["句子ID"]}""",
        },
        {
            "role": "user",
            "content": (
                f"用户问题：{query}\n\n候选句子：\n"
                f"{json.dumps(sentence_records, ensure_ascii=False, indent=2)}"
            ),
        },
    ]


def compress_context(
    query: str,
    documents: list[dict[str, Any]],
    *,
    api_key: str | None = None,
    chat_model: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> list[dict[str, str]]:
    """让模型选择句子 ID，再由程序从原文中取回内容。"""
    resolved_api_key = resolve_api_key(api_key)
    resolved_model = (
        chat_model
        if chat_model is not None
        else os.getenv("CHAT_MODEL", DEFAULT_CHAT_MODEL)
    )

    # 先把 Chunk 拆成句子级别的候选项。
    sentence_records = create_sentence_records(documents)

    result = requester(
        {
            "model": resolved_model,
            "messages": build_compression_messages(query, sentence_records),
            # 强制模型返回 JSON 对象，降低解析失败概率。
            "response_format": {"type": "json_object"},
            # 当前任务只做抽取，关闭 thinking 以降低延迟和成本。
            "thinking": {"type": "disabled"},
            # temperature 设为 0，让选择结果尽量稳定。
            "temperature": 0,
            "stream": False,
        },
        resolved_api_key,
    )

    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("Context Compression 没有返回可用内容。") from error

    if not content:
        raise RuntimeError("Context Compression 没有返回可用内容。")

    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError(
            f"Context Compression 没有返回合法 JSON：{content}"
        ) from error

    selected_sentence_ids = (
        parsed.get("selectedSentenceIds")
        if isinstance(parsed, dict)
        else None
    )
    if not isinstance(selected_sentence_ids, list):
        raise ValueError("selectedSentenceIds 必须是数组。")

    # 建立 sentenceId 到原始句子的映射，方便快速取回原文。
    sentence_map = {
        sentence["sentenceId"]: sentence for sentence in sentence_records
    }

    # 按模型返回顺序去重，并校验每个句子 ID 都来自候选原文。
    unique_sentence_ids: list[str] = []
    for sentence_id in selected_sentence_ids:
        if not isinstance(sentence_id, str) or sentence_id not in sentence_map:
            raise ValueError(f"模型返回了不存在的句子 ID：{sentence_id}")
        if sentence_id not in unique_sentence_ids:
            unique_sentence_ids.append(sentence_id)

    selected_sentences = [
        sentence_map[sentence_id] for sentence_id in unique_sentence_ids
    ]

    # 按原始文档维度重新组装压缩后的上下文。
    compressed_documents: list[dict[str, str]] = []
    for document in documents:
        content = "".join(
            sentence["text"]
            for sentence in selected_sentences
            if sentence["chunkId"] == document["id"]
        )
        if content:
            compressed_documents.append(
                {
                    "id": document["id"],
                    "title": document["title"],
                    "content": content,
                }
            )

    return compressed_documents


def print_documents(
    title: str, documents: list[dict[str, Any]], score_name: str
) -> None:
    """打印文档列表及指定的分数字段。"""
    print(f"\n================ {title} ================")

    for index, document in enumerate(documents, start=1):
        print(f"\n{index}. {document['title']}")
        print(f"Chunk ID：{document['id']}")
        print(f"Score：{float(document[score_name]):.6f}")
        print(f"Content：{document['content']}")


def build_final_context(documents: list[dict[str, str]]) -> str:
    """构造带 Chunk ID 和标题的最终上下文。"""
    return "\n\n".join(
        f"[{document['id']} | {document['title']}]\n{document['content']}"
        for document in documents
    )


def main() -> None:
    """运行 Rerank 和抽取式 Context Compression 完整流程。"""
    print(f"用户问题：{question}")
    print_documents("当前候选资料", candidates, "retrievalScore")

    # 第一步：重新排序候选资料，保留最相关的 Top4。
    reranked_documents = rerank_documents(question, candidates)
    print_documents("Rerank 之后的 Top4", reranked_documents, "rerankScore")

    # 第二步：让模型选择有用句子，再从原文中取回内容。
    compressed_documents = compress_context(question, reranked_documents)

    original_length = sum(
        len(document["content"]) for document in reranked_documents
    )
    compressed_length = sum(
        len(document["content"]) for document in compressed_documents
    )

    print("\n================ Context Compression ================")
    print(f"压缩前字符数：{original_length}")
    print(f"压缩后字符数：{compressed_length}")

    print("\n最终交给大模型的上下文：")
    print(build_final_context(compressed_documents))


if __name__ == "__main__":
    main()

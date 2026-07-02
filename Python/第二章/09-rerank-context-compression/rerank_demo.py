"""使用智谱 Rerank API 对候选文档重新排序。"""

import json
import os
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from candidate_documents import candidates, question


DEFAULT_RERANK_MODEL = "rerank"
RerankRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def request_rerank(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """使用 Python 标准库调用智谱 Rerank API。"""
    request = Request(
        "https://open.bigmodel.cn/api/paas/v4/rerank",
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
            f"Rerank API 调用失败：{error.code} {error_text}"
        ) from error


def rerank_documents(
    query: str,
    documents: list[dict[str, Any]],
    top_n: int = 4,
    *,
    api_key: str | None = None,
    rerank_model: str | None = None,
    requester: RerankRequester = request_rerank,
) -> list[dict[str, Any]]:
    """使用 Rerank 模型返回相关性最高的前 top_n 条文档。"""
    # 调用 API 前先检查环境变量中是否配置了 API Key。
    resolved_api_key = (
        api_key if api_key is not None else os.getenv("ZHIPU_API_KEY")
    )
    if not resolved_api_key:
        raise RuntimeError("没有检测到 ZHIPU_API_KEY，请先配置 .env。")

    resolved_model = (
        rerank_model
        if rerank_model is not None
        else os.getenv("RERANK_MODEL", DEFAULT_RERANK_MODEL)
    )

    # 调用智谱 Rerank API，对候选文档进行相关性重排序。
    result = requester(
        {
            # 使用的 Rerank 模型。
            "model": resolved_model,
            # 用户原始问题。
            "query": query,
            # Rerank 接收字符串数组，这里把标题和正文拼成完整候选文本。
            "documents": [
                f"{document['title']}\n{document['content']}"
                for document in documents
            ],
            # 只返回相关性最高的前 top_n 条。
            "top_n": top_n,
            # 不返回原始文档，后面通过 index 从本地 documents 中取回。
            "return_documents": False,
            # 返回原始相关性分数，方便观察排序效果。
            "return_raw_scores": True,
        },
        resolved_api_key,
    )

    # 防御式校验：确保接口返回了 results 列表。
    results = result.get("results") if isinstance(result, dict) else None
    if not isinstance(results, list):
        raise RuntimeError("Rerank API 没有返回可用的 results。")

    reranked_documents: list[dict[str, Any]] = []
    for item in results:
        index = item.get("index") if isinstance(item, dict) else None

        # 如果接口返回了不存在的下标，说明结果异常。
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or index < 0
            or index >= len(documents)
        ):
            raise RuntimeError(f"Rerank API 返回了无效文档下标：{index}")

        # 保留原始文档信息，并追加 Rerank 计算出的相关性分数。
        reranked_documents.append(
            {
                **documents[index],
                "rerankScore": item.get("relevance_score"),
            }
        )

    return reranked_documents


def print_documents(
    title: str, documents: list[dict[str, Any]], score_name: str
) -> None:
    """打印文档标题、Chunk ID、指定分数和正文。"""
    print(f"\n================ {title} ================")

    for index, document in enumerate(documents, start=1):
        print(f"\n{index}. {document['title']}")
        print(f"Chunk ID：{document['id']}")
        # 根据 score_name 动态读取分数字段，并统一保留 6 位小数。
        print(f"Score：{float(document[score_name]):.6f}")
        print(f"Content：{document['content']}")


def main() -> None:
    """打印原始召回结果，并展示 Rerank 后的 Top4。"""
    print(f"用户问题：{question}")
    print_documents("当前候选资料", candidates, "retrievalScore")

    reranked_documents = rerank_documents(question, candidates)
    print_documents("Rerank 之后的 Top4", reranked_documents, "rerankScore")


if __name__ == "__main__":
    main()

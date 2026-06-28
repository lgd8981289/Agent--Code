"""构建内存向量库，并根据用户问题检索 TopK 文档。"""

import json
import math
import os
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


model = os.getenv("EMBEDDING_MODEL", "embedding-3")
dimensions = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))
supported_dimensions = {256, 512, 1024, 2048}

# 本节使用的测试知识库。
# 后面接入真实文档时，这些内容会来自 Markdown、PDF 或业务系统。
documents = [
    {
        "id": "blue-whale-refund-rule",
        "title": "蓝鲸退款规则",
        "content": """普通商品签收后 7 天内可以申请退款。
生鲜商品不支持无理由退款。
退款金额超过 2000 元时，需要人工审核。""",
    },
    {
        "id": "refund-apply-process",
        "title": "退款申请流程",
        "content": """用户可以在订单详情页提交退款申请。
系统会先校验订单状态、签收时间和商品类型。
需要人工审核的退款申请，会进入客服审核队列。""",
    },
    {
        "id": "shipping-policy",
        "title": "商品发货规则",
        "content": """现货商品将在付款后 48 小时内发货。
偏远地区可能增加 1 到 3 天配送时间。""",
    },
    {
        "id": "invoice-policy",
        "title": "电子发票规则",
        "content": """订单完成后可以申请电子发票。
企业发票需要提供公司抬头和税号。""",
    },
    {
        "id": "warranty-policy",
        "title": "售后保修规则",
        "content": """电器商品享受 1 年整机保修。
人为损坏、进水和自行拆机不在免费保修范围内。""",
    },
    {
        "id": "coupon-policy",
        "title": "优惠券使用规则",
        "content": """优惠券需要在有效期内使用。
已经过期的优惠券不能恢复，也不能兑换成现金。""",
    },
]

EmbeddingRequester = Callable[[dict[str, Any], str], dict[str, Any]]
EmbeddingCreator = Callable[[list[str]], list[list[float]]]


def request_embeddings(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """使用 Python 标准库调用智谱 Embeddings API。"""
    request = Request(
        "https://open.bigmodel.cn/api/paas/v4/embeddings",
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
            f"Embedding API 调用失败：{error.code} {error_text}"
        ) from error


def create_embeddings(
    inputs: list[str],
    *,
    api_key: str | None = None,
    requester: EmbeddingRequester = request_embeddings,
) -> list[list[float]]:
    """批量生成向量，并按响应 index 恢复输入顺序。"""
    resolved_api_key = api_key or os.getenv("ZHIPU_API_KEY")
    if not resolved_api_key:
        raise RuntimeError("没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。")
    if dimensions not in supported_dimensions:
        raise ValueError("EMBEDDING_DIMENSIONS 只能是 256、512、1024 或 2048。")
    if len(inputs) > 64:
        raise ValueError("embedding-3 单次请求的数组最大不能超过 64 条。")

    result = requester(
        {
            "model": model,
            "input": inputs,
            "dimensions": dimensions,
        },
        resolved_api_key,
    )
    try:
        sorted_items = sorted(result["data"], key=lambda item: item["index"])
        return [item["embedding"] for item in sorted_items]
    except (KeyError, TypeError) as error:
        raise RuntimeError("Embedding API 没有返回可用的向量。") from error


def cosine_similarity(
    first_vector: list[float], second_vector: list[float]
) -> float:
    """计算两个等长非零向量的余弦相似度。"""
    if len(first_vector) != len(second_vector):
        raise ValueError(
            f"向量维度不一致：{len(first_vector)} !== {len(second_vector)}"
        )

    dot_product = sum(
        first * second
        for first, second in zip(first_vector, second_vector)
    )
    first_length = sum(value**2 for value in first_vector)
    second_length = sum(value**2 for value in second_vector)
    if first_length == 0 or second_length == 0:
        raise ValueError("不能计算零向量的余弦相似度。")

    return dot_product / (math.sqrt(first_length) * math.sqrt(second_length))


def build_memory_vector_store(
    raw_documents: list[dict[str, Any]],
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> list[dict[str, Any]]:
    """为每份文档生成向量，并将向量和原始文档保存在一起。"""
    vectors = embedding_creator(
        [document["content"] for document in raw_documents]
    )
    return [
        {**document, "vector": vectors[index]}
        for index, document in enumerate(raw_documents)
    ]


def search_top_k(
    *,
    store: list[dict[str, Any]],
    query: str,
    top_k: int = 3,
    min_similarity: float = 0,
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> list[dict[str, Any]]:
    """把问题转换成向量，再检索满足阈值的 TopK 文档。"""
    query_vector = embedding_creator([query])[0]
    candidates: list[dict[str, Any]] = []

    for document in store:
        similarity = cosine_similarity(query_vector, document["vector"])
        print(f"document.similarity：{similarity}")
        print(f"document.content：{document['content']}\n")

        if similarity >= min_similarity:
            candidates.append(
                {
                    "id": document["id"],
                    "title": document["title"],
                    "content": document["content"],
                    "similarity": similarity,
                    "distance": 1 - similarity,
                }
            )

    candidates.sort(key=lambda item: item["similarity"], reverse=True)
    return candidates[:top_k]


def print_search_results(results: list[dict[str, Any]]) -> None:
    """格式化打印检索结果。"""
    for index, item in enumerate(results, start=1):
        print(
            {
                "rank": index,
                "id": item["id"],
                "title": item["title"],
                "similarity": f"{item['similarity']:.6f}",
                "distance": f"{item['distance']:.6f}",
            }
        )


def build_context(results: list[dict[str, Any]]) -> str:
    """把 TopK 结果拼接成准备交给大模型的参考资料。"""
    return "\n\n".join(
        f"【{item['title']}】\n{item['content']}"
        for item in results
    )


def run_demo(
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> dict[str, Any]:
    """构建索引、执行检索并输出模型参考资料。"""
    print(f"Embedding 模型：{model}")
    print(f"向量维度：{dimensions}")
    print("\n正在构建内存向量索引...")
    store = build_memory_vector_store(documents, embedding_creator)
    print(f"索引构建完成，文档数量：{len(store)}")

    query = (
        "我买的咖啡机 3000 元，现在想退货。这个订单需要人工审核吗？"
        "如果要退，具体流程怎么走？"
    )
    print("\n用户问题：")
    print(query)

    results = search_top_k(
        store=store,
        query=query,
        top_k=3,
        min_similarity=0,
        embedding_creator=embedding_creator,
    )
    print("\nTopK 检索结果：")
    print_search_results(results)

    context = build_context(results)
    print("\n准备交给模型的参考资料：")
    print(context)
    return {"store": store, "results": results, "context": context}


def main() -> int:
    """运行内存向量检索并输出可预期错误。"""
    try:
        run_demo()
    except (RuntimeError, ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

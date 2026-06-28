"""调用 Embedding API，并使用余弦相似度完成语义检索。"""

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

# 继续使用上一节的三份企业资料。
documents = [
    {
        "id": "blue-whale-refund",
        "title": "蓝鲸退款规则",
        "content": """普通商品签收后 7 天内可以申请退款。
退款金额超过 2000 元时，需要人工审核。""",
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
]

EmbeddingRequester = Callable[[dict[str, Any], str], dict[str, Any]]


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
    """批量生成向量，并根据响应 index 恢复输入顺序。"""
    resolved_api_key = api_key or os.getenv("ZHIPU_API_KEY")
    if not resolved_api_key:
        raise RuntimeError("没有检测到 ZHIPU_API_KEY，请先在 .env 中配置。")

    # embedding-3 只支持指定的向量维度。
    if dimensions not in supported_dimensions:
        raise ValueError("EMBEDDING_DIMENSIONS 只能是 256、512、1024 或 2048。")

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

    dot_product = 0.0
    first_length = 0.0
    second_length = 0.0

    for first_value, second_value in zip(first_vector, second_vector):
        dot_product += first_value * second_value
        first_length += first_value**2
        second_length += second_value**2

    # 零向量没有方向，不能计算余弦相似度。
    if first_length == 0 or second_length == 0:
        raise ValueError("不能计算零向量的余弦相似度。")

    return dot_product / (math.sqrt(first_length) * math.sqrt(second_length))


def rank_documents(
    question_vector: list[float], document_vectors: list[list[float]]
) -> list[dict[str, Any]]:
    """计算问题与每份资料的相似度，并按相似度从高到低排序。"""
    results = [
        {
            "id": document["id"],
            "title": document["title"],
            "similarity": cosine_similarity(
                question_vector, document_vectors[index]
            ),
        }
        for index, document in enumerate(documents)
    ]
    results.sort(key=lambda item: item["similarity"], reverse=True)
    return results


def run_demo(
    *,
    api_key: str | None = None,
    requester: EmbeddingRequester = request_embeddings,
) -> list[dict[str, Any]]:
    """生成问题和资料向量，再完成一次语义检索。"""
    question = "咖啡机不想要了，3000 元的订单应该走自动流程还是人工处理？"

    # 把问题和全部资料放进同一个请求，减少 API 调用次数。
    inputs = [question, *[document["content"] for document in documents]]
    vectors = create_embeddings(
        inputs,
        api_key=api_key,
        requester=requester,
    )
    question_vector, *document_vectors = vectors

    print(f"Embedding 模型：{model}")
    print(f"向量维度：{len(question_vector)}")
    print("问题向量的前 8 个数字：")
    print(question_vector[:8])

    results = rank_documents(question_vector, document_vectors)
    print("\n语义检索结果：")
    for item in results:
        print(
            {
                **item,
                "similarity": f"{item['similarity']:.6f}",
            }
        )
    print(f"最相关的资料：{results[0]['title']}")
    return results


def main() -> int:
    """运行语义检索并输出可预期错误。"""
    try:
        run_demo()
    except (RuntimeError, ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

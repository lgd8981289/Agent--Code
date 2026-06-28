"""对比整篇文档检索与分块检索返回的上下文。"""

import json
import math
import os
import re
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


model = os.getenv("EMBEDDING_MODEL", "embedding-3")
dimensions = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))
supported_dimensions = {256, 512, 1024, 2048}
query = "3000 元退款需要人工审核吗？"

# 方案一：把完整售后手册作为一个检索单位。
whole_manual = {
    "id": "after-sales-manual-full",
    "title": "售后手册全文",
    "type": "whole-document",
    "content": """# 售后手册

## 退款规则
普通商品签收后 7 天内可以申请退款。
退款金额超过 2000 元时，需要进入人工审核流程。
用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。
如果订单命中人工审核规则，退款申请会进入客服审核队列。

## 发货规则
现货商品会在付款后 48 小时内发货。
偏远地区可能增加 1 到 3 天配送时间。
如果订单中包含预售商品，整单会按照预售商品的发货时间处理。

## 发票规则
订单完成后可以申请电子发票。
企业发票需要提供公司抬头和税号。
发票开具后会发送到用户邮箱。

## 保修规则
电器商品享受 1 年整机保修。
人为损坏、进水和自行拆机不在免费保修范围内。

## 优惠券规则
优惠券需要在有效期内使用。
已经过期的优惠券不能恢复，也不能兑换成现金。

## 会员积分规则
用户完成订单后可以获得积分。
积分可以在积分商城兑换优惠券。""",
}

# 方案二：把手册提前拆成多个语义相对独立的 Chunk。
chunk_documents = [
    {
        "id": "refund-rule-chunk",
        "title": "Chunk 1：退款规则",
        "type": "chunk",
        "content": """普通商品签收后 7 天内可以申请退款。
退款金额超过 2000 元时，需要进入人工审核流程。
用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。
如果订单命中人工审核规则，退款申请会进入客服审核队列。""",
    },
    {
        "id": "shipping-rule-chunk",
        "title": "Chunk 2：发货规则",
        "type": "chunk",
        "content": """现货商品会在付款后 48 小时内发货。
偏远地区可能增加 1 到 3 天配送时间。
如果订单中包含预售商品，整单会按照预售商品的发货时间处理。""",
    },
    {
        "id": "invoice-rule-chunk",
        "title": "Chunk 3：发票规则",
        "type": "chunk",
        "content": """订单完成后可以申请电子发票。
企业发票需要提供公司抬头和税号。
发票开具后会发送到用户邮箱。""",
    },
    {
        "id": "warranty-rule-chunk",
        "title": "Chunk 4：保修规则",
        "type": "chunk",
        "content": """电器商品享受 1 年整机保修。
人为损坏、进水和自行拆机不在免费保修范围内。""",
    },
    {
        "id": "coupon-rule-chunk",
        "title": "Chunk 5：优惠券规则",
        "type": "chunk",
        "content": """优惠券需要在有效期内使用。
已经过期的优惠券不能恢复，也不能兑换成现金。""",
    },
    {
        "id": "points-rule-chunk",
        "title": "Chunk 6：会员积分规则",
        "type": "chunk",
        "content": """用户完成订单后可以获得积分。
积分可以在积分商城兑换优惠券。""",
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
        {"model": model, "input": inputs, "dimensions": dimensions},
        resolved_api_key,
    )
    try:
        sorted_items = sorted(result["data"], key=lambda item: item["index"])
        return [item["embedding"] for item in sorted_items]
    except (KeyError, TypeError) as error:
        raise RuntimeError("Embedding API 没有返回可用的向量。") from error


def cosine_similarity(first: list[float], second: list[float]) -> float:
    """计算两个等长非零向量的余弦相似度。"""
    if len(first) != len(second):
        raise ValueError(f"向量维度不一致：{len(first)} !== {len(second)}")
    dot_product = sum(a * b for a, b in zip(first, second))
    first_length = sum(value**2 for value in first)
    second_length = sum(value**2 for value in second)
    if first_length == 0 or second_length == 0:
        raise ValueError("不能计算零向量的余弦相似度。")
    return dot_product / (math.sqrt(first_length) * math.sqrt(second_length))


def preview(text: str) -> str:
    """把长内容压缩成适合终端展示的预览。"""
    return re.sub(r"\s+", " ", text)[:58]


def search_top_k(
    *,
    query_vector: list[float],
    store: list[dict[str, Any]],
    top_k: int,
) -> list[dict[str, Any]]:
    """计算问题与每条数据的相似度，并返回 TopK。"""
    results = [
        {
            "id": document["id"],
            "title": document["title"],
            "type": document["type"],
            "content": document["content"],
            "contentLength": len(document["content"]),
            "similarity": cosine_similarity(query_vector, document["vector"]),
        }
        for document in store
    ]
    results.sort(key=lambda item: item["similarity"], reverse=True)
    return results[:top_k]


def print_results(results: list[dict[str, Any]]) -> None:
    """打印检索结果及内容长度。"""
    for index, item in enumerate(results, start=1):
        print(
            {
                "rank": index,
                "title": item["title"],
                "type": item["type"],
                "similarity": f"{item['similarity']:.6f}",
                "contentLength": item["contentLength"],
                "preview": item["content"],
            }
        )


def build_context(results: list[dict[str, Any]]) -> str:
    """把检索结果组装成准备交给模型的上下文。"""
    return "\n\n".join(
        f"【{item['title']}】\n{item['content']}"
        for item in results
    )


def run_demo(
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> dict[str, Any]:
    """对比整篇文档检索和 Chunk 检索。"""
    print(f"Embedding 模型：{model}")
    print(f"向量维度：{dimensions}")
    print("\n用户问题：")
    print(query)

    all_documents = [whole_manual, *chunk_documents]
    query_vector, *document_vectors = embedding_creator(
        [query, *[document["content"] for document in all_documents]]
    )
    vector_store = [
        {**document, "vector": document_vectors[index]}
        for index, document in enumerate(all_documents)
    ]

    whole_results = search_top_k(
        query_vector=query_vector,
        store=[item for item in vector_store if item["type"] == "whole-document"],
        top_k=1,
    )
    chunk_results = search_top_k(
        query_vector=query_vector,
        store=[item for item in vector_store if item["type"] == "chunk"],
        top_k=1,
    )

    print("\n================ 方案一：整份文档作为检索单位 ================")
    print_results(whole_results)
    whole_context = build_context(whole_results)
    print(f"准备交给模型的上下文长度：{len(whole_context)} 字")
    print("可以看到，TopK 只能返回整份《售后手册》。")

    print("\n================ 方案二：分块后作为检索单位 ================")
    print_results(chunk_results)
    chunk_context = build_context(chunk_results)
    print(f"准备交给模型的上下文长度：{len(chunk_context)} 字")
    print("可以看到，TopK 可以返回更接近问题的 Chunk。")

    print("\n================ 对比结论 ================")
    comparison = [
        {
            "mode": "整份文档",
            "topResult": whole_results[0]["title"],
            "contextLength": len(whole_context),
            "meaning": "命中的是整份手册，里面混着很多和问题无关的内容。",
        },
        {
            "mode": "分块文档",
            "topResult": chunk_results[0]["title"],
            "contextLength": len(chunk_context),
            "meaning": "命中的是更小的规则片段，更适合放进模型上下文。",
        },
    ]
    for item in comparison:
        print(item)

    return {
        "wholeResults": whole_results,
        "chunkResults": chunk_results,
        "wholeContext": whole_context,
        "chunkContext": chunk_context,
        "comparison": comparison,
    }


def main() -> int:
    """运行对比实验并输出可预期错误。"""
    try:
        run_demo()
    except (RuntimeError, ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

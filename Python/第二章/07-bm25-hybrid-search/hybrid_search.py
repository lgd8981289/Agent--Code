"""对比 Dense、BM25、Weighted 和 RRF 四种检索方式。"""

import json
import os
import re
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pymilvus import (
    AnnSearchRequest,
    DataType,
    Function,
    FunctionType,
    MilvusClient,
    RRFRanker,
    WeightedRanker,
)


# Embedding 配置。
embedding_model = os.getenv("EMBEDDING_MODEL", "embedding-3")
dimensions = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))

# 为混合检索使用专用 Collection，避免覆盖前面课程的数据。
configured_collection_name = (os.getenv("MILVUS_COLLECTION") or "").strip()
collection_name = (
    "agent_course_hybrid_recall_demo"
    if not configured_collection_name
    or configured_collection_name == "agent_course_chunks"
    else configured_collection_name
)

# 四种方法最终都返回 Top3；混合检索每一路先召回 Top5。
FINAL_TOP_K = 3
ROUTE_TOP_K = 5

METHOD_NAMES = {
    "Dense": "向量检索（Dense）",
    "BM25": "BM25 全文检索",
    "Weighted": "归一化 Weighted 融合",
    "RRF": "RRF 排名融合",
}

# 每一条数据都会同时参与 Dense 和 BM25 检索。
documents = [
    {
        "id": "refund-threshold",
        "title": "退款金额审核规则",
        "content": """# 蓝鲸退款规则

普通商品签收后 7 天内可以申请退款。

生鲜商品不支持无理由退款。

退款金额超过 3000 元时，需要进入人工审核流程。

用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。""",
    },
    {
        "id": "refund-workflow",
        "title": "人工审核流程",
        "content": """人工审核流程。

用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。

如果订单命中人工审核规则，退款申请会进入客服审核队列。客服审核通过后，系统再进入退款打款流程。""",
    },
    {
        "id": "order-cancellation",
        "title": "高价值订单取消流程",
        "content": "高价值交易申请撤销后不会立即关闭，需要转交业务专员复核，再决定是否终止订单。",
    },
    {
        "id": "refund-arrival",
        "title": "退款到账时间",
        "content": "退款原路退回银行卡通常需要 1 到 5 个工作日。",
    },
    {
        "id": "rule-map",
        "title": "规则编号映射表",
        "content": "内部规则映射：BW-RF-2026 对应蓝鲸退款规则。",
    },
    {
        "id": "rule-guide",
        "title": "售后规则查询说明",
        "content": "用户提供规则编号后，客服可以查询对应的售后规则名称和适用范围。",
    },
    {
        "id": "shipping-policy",
        "title": "商品发货规则",
        "content": "现货商品会在付款后 48 小时内发货。",
    },
    {
        "id": "invoice-policy",
        "title": "发票开具规则",
        "content": "订单完成后，用户可以在订单详情页申请电子发票。",
    },
]

# relevantIds 是人工标注的标准答案，用来计算 Recall@3。
evaluation_cases = [
    {
        "name": "口语化退款问题",
        "question": "这台设备花了三千五，现在想退掉，能让系统直接通过，还是必须找工作人员看一下？",
        "relevantIds": ["refund-threshold", "refund-workflow"],
    },
    {
        "name": "精确规则编号",
        "question": "BW-RF-2026",
        "relevantIds": ["rule-map"],
    },
    {
        "name": "退款到账时间",
        "question": "钱已经退了，什么时候能到银行卡？",
        "relevantIds": ["refund-arrival"],
    },
]

EmbeddingRequester = Callable[[dict[str, Any], str], dict[str, Any]]
EmbeddingCreator = Callable[[list[str]], list[list[float]]]
ClientFactory = Callable[[], Any]


def normalize_milvus_uri(address: str) -> str:
    """规范化本地地址，并把 localhost 替换成 127.0.0.1。"""
    normalized = re.sub(
        r"(^|://)localhost(?=:\d+$)",
        r"\g<1>127.0.0.1",
        address.strip(),
    )
    return normalized if "://" in normalized else f"http://{normalized}"


def connect_milvus() -> MilvusClient:
    """连接本地 Milvus 或 Zilliz Cloud，并主动验证连接。"""
    address = os.getenv("MILVUS_ADDRESS", "http://127.0.0.1:19530")
    token = (os.getenv("MILVUS_TOKEN") or "").strip()
    options: dict[str, Any] = {"uri": normalize_milvus_uri(address)}
    if token:
        options["token"] = token

    try:
        client = MilvusClient(**options)
        client.list_collections()
        return client
    except Exception as error:
        raise RuntimeError(
            "无法连接 Milvus。请先执行 "
            "docker compose up -d --wait --wait-timeout 180。"
        ) from error


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
        raise RuntimeError("没有检测到 ZHIPU_API_KEY，请先配置 .env。")

    result = requester(
        {
            "model": embedding_model,
            "input": inputs,
            "dimensions": dimensions,
        },
        resolved_api_key,
    )
    try:
        items = sorted(result["data"], key=lambda item: item["index"])
        return [item["embedding"] for item in items]
    except (KeyError, TypeError) as error:
        raise RuntimeError("Embedding API 没有返回可用的向量。") from error


def build_collection_schema() -> tuple[Any, Any]:
    """构建同时支持 Dense 与 BM25 的 Schema 和索引。"""
    schema = MilvusClient.create_schema(
        auto_id=False,
        enable_dynamic_field=False,
    )
    schema.add_field(
        field_name="id",
        datatype=DataType.VARCHAR,
        is_primary=True,
        max_length=128,
    )
    schema.add_field(
        field_name="title",
        datatype=DataType.VARCHAR,
        max_length=256,
    )

    # BM25 需要对原文开启 Analyzer。jieba 负责中文分词，removepunct 移除标点。
    schema.add_field(
        field_name="content",
        datatype=DataType.VARCHAR,
        max_length=1024,
        enable_analyzer=True,
        enable_match=True,
        analyzer_params={
            "tokenizer": "jieba",
            "filter": ["removepunct"],
        },
    )
    schema.add_field(
        field_name="embedding",
        datatype=DataType.FLOAT_VECTOR,
        dim=dimensions,
    )
    schema.add_field(
        field_name="sparse_embedding",
        datatype=DataType.SPARSE_FLOAT_VECTOR,
    )

    # Milvus 会根据 content 自动生成 sparse_embedding，写入时无需手动提供。
    schema.add_function(
        Function(
            name="content_bm25",
            function_type=FunctionType.BM25,
            input_field_names=["content"],
            output_field_names=["sparse_embedding"],
            params={},
        )
    )

    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(
        field_name="embedding",
        index_type="AUTOINDEX",
        metric_type="COSINE",
    )
    index_params.add_index(
        field_name="sparse_embedding",
        index_type="SPARSE_INVERTED_INDEX",
        metric_type="BM25",
        params={
            "inverted_index_algo": "DAAT_MAXSCORE",
            "bm25_k1": 1.2,
            "bm25_b": 0.75,
        },
    )
    return schema, index_params


def recreate_collection(client: Any) -> None:
    """删除旧 Collection，再创建一个干净的混合检索 Collection。"""
    if client.has_collection(collection_name=collection_name):
        client.drop_collection(collection_name=collection_name)

    schema, index_params = build_collection_schema()
    client.create_collection(
        collection_name=collection_name,
        schema=schema,
        index_params=index_params,
    )


def insert_documents(
    client: Any,
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> None:
    """生成 Dense 向量并写入文档；BM25 稀疏向量由 Milvus 自动生成。"""
    embeddings = embedding_creator(
        [document["content"] for document in documents]
    )
    rows = [
        {**document, "embedding": embeddings[index]}
        for index, document in enumerate(documents)
    ]
    client.insert(collection_name=collection_name, data=rows)
    client.flush(collection_name=collection_name)
    client.load_collection(collection_name=collection_name)


def normalize_search_results(raw_results: Any) -> list[dict[str, Any]]:
    """把 PyMilvus 的嵌套 hit/entity 结构整理成课程统一格式。"""
    if not raw_results:
        return []
    hits = raw_results[0] if isinstance(raw_results[0], list) else raw_results
    results: list[dict[str, Any]] = []
    for hit in hits:
        entity = dict(hit.get("entity") or {})
        entity.setdefault("id", hit.get("id"))
        entity["score"] = hit.get("distance", hit.get("score", 0))
        results.append(entity)
    return results


def dense_search(client: Any, query_vector: list[float], limit: int) -> list[dict[str, Any]]:
    """只搜索 Dense embedding 字段。"""
    raw_results = client.search(
        collection_name=collection_name,
        anns_field="embedding",
        data=[query_vector],
        limit=limit,
        output_fields=["id", "title", "content"],
    )
    return normalize_search_results(raw_results)


def bm25_search(client: Any, question: str, limit: int) -> list[dict[str, Any]]:
    """把原始问题交给 BM25 Function，搜索 sparse_embedding 字段。"""
    raw_results = client.search(
        collection_name=collection_name,
        anns_field="sparse_embedding",
        data=[question],
        limit=limit,
        output_fields=["id", "title", "content"],
    )
    return normalize_search_results(raw_results)


def normalized_weighted_ranker(weights: list[float]) -> WeightedRanker:
    """创建开启分数归一化的 Weighted Ranker。"""
    return WeightedRanker(*weights, norm_score=True)


def hybrid_search(
    client: Any,
    question: str,
    query_vector: list[float],
    ranker: Any,
) -> list[dict[str, Any]]:
    """执行 Dense 与 BM25 两路召回，再融合成最终 Top3。"""
    requests = [
        AnnSearchRequest(
            data=[query_vector],
            anns_field="embedding",
            param={},
            limit=ROUTE_TOP_K,
        ),
        AnnSearchRequest(
            data=[question],
            anns_field="sparse_embedding",
            param={},
            limit=ROUTE_TOP_K,
        ),
    ]
    raw_results = client.hybrid_search(
        collection_name=collection_name,
        reqs=requests,
        ranker=ranker,
        limit=FINAL_TOP_K,
        output_fields=["id", "title", "content"],
    )
    return normalize_search_results(raw_results)


def recall_at_k(results: list[dict[str, Any]], relevant_ids: list[str]) -> float:
    """计算 TopK 中命中的标准答案数量占标准答案总数的比例。"""
    result_ids = {item["id"] for item in results}
    hit_count = sum(relevant_id in result_ids for relevant_id in relevant_ids)
    return hit_count / len(relevant_ids)


def print_expected_documents(relevant_ids: list[str]) -> None:
    """打印人工标注的标准答案，方便和检索结果对照。"""
    document_map = {document["id"]: document for document in documents}
    print("\n标准答案：")
    for relevant_id in relevant_ids:
        document = document_map[relevant_id]
        print(
            {
                "id": document["id"],
                "title": document["title"],
                "content": document["content"].replace("\n", " ")[:60],
            }
        )


def print_search_results(route: dict[str, Any], relevant_ids: list[str]) -> None:
    """打印排名、命中情况、相关性分数和文档预览。"""
    relevant_id_set = set(relevant_ids)
    recall = recall_at_k(route["results"], relevant_ids)
    print(f"\n{route['name']}，Recall@{FINAL_TOP_K}={recall:.2f}")
    for index, item in enumerate(route["results"], start=1):
        print(
            {
                "rank": index,
                "hit": "YES" if item["id"] in relevant_id_set else "",
                "score": f"{float(item['score']):.6f}",
                "id": item["id"],
                "title": item.get("title"),
                "content": str(item.get("content", "")).replace("\n", " ")[:60],
            }
        )


def evaluate_case(
    client: Any,
    evaluation_case: dict[str, Any],
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> dict[str, float]:
    """用四种检索方式评估一个问题，并返回各自 Recall@3。"""
    query_vector = embedding_creator([evaluation_case["question"]])[0]
    dense_results = dense_search(client, query_vector, FINAL_TOP_K)
    bm25_results = bm25_search(client, evaluation_case["question"], FINAL_TOP_K)
    weighted_results = hybrid_search(
        client,
        evaluation_case["question"],
        query_vector,
        normalized_weighted_ranker([0.8, 0.2]),
    )
    rrf_results = hybrid_search(
        client,
        evaluation_case["question"],
        query_vector,
        RRFRanker(60),
    )

    routes = [
        {"key": "Dense", "name": METHOD_NAMES["Dense"], "results": dense_results},
        {"key": "BM25", "name": METHOD_NAMES["BM25"], "results": bm25_results},
        {
            "key": "Weighted",
            "name": METHOD_NAMES["Weighted"],
            "results": weighted_results,
        },
        {"key": "RRF", "name": METHOD_NAMES["RRF"], "results": rrf_results},
    ]

    print(f"\n\n================ {evaluation_case['name']} ================")
    print(f"输入：{evaluation_case['question']}")
    print_expected_documents(evaluation_case["relevantIds"])
    for route in routes:
        print_search_results(route, evaluation_case["relevantIds"])

    print("\n本题结果汇总：")
    for route in routes:
        print(
            {
                "method": route["name"],
                "results": " -> ".join(
                    item["title"] for item in route["results"]
                ),
                f"Recall@{FINAL_TOP_K}": (
                    f"{recall_at_k(route['results'], evaluation_case['relevantIds']):.2f}"
                ),
            }
        )

    return {
        route["key"]: recall_at_k(
            route["results"], evaluation_case["relevantIds"]
        )
        for route in routes
    }


def run_demo(
    client_factory: ClientFactory = connect_milvus,
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> dict[str, float]:
    """重建 Collection、写入文档，并计算四种方法的平均 Recall@3。"""
    client = client_factory()
    try:
        recreate_collection(client)
        insert_documents(client, embedding_creator)

        print(f"Collection：{collection_name}")
        print(f"文档数量：{len(documents)}")
        print(
            f"统一评估条件：单路 Top{FINAL_TOP_K}；"
            f"混合检索每路 Top{ROUTE_TOP_K}，最终 Top{FINAL_TOP_K}"
        )

        totals = {"Dense": 0.0, "BM25": 0.0, "Weighted": 0.0, "RRF": 0.0}
        for evaluation_case in evaluation_cases:
            recalls = evaluate_case(client, evaluation_case, embedding_creator)
            for method in totals:
                totals[method] += recalls[method]

        averages = {
            method: total / len(evaluation_cases)
            for method, total in totals.items()
        }
        print("\n整体评估结果：")
        for method, average in averages.items():
            print(
                {
                    "method": METHOD_NAMES[method],
                    f"平均 Recall@{FINAL_TOP_K}": f"{average:.2f}",
                }
            )
        return averages
    finally:
        client.close()


def main() -> int:
    """运行示例，并把常见错误转换成清晰提示。"""
    try:
        run_demo()
    except (RuntimeError, ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

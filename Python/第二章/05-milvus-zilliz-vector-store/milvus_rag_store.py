"""使用 PyMilvus 完成 Chunk 入库、检索和退款规则更新。"""

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pymilvus import DataType, MilvusClient


# Embedding 配置必须与 Milvus Collection 的向量字段保持一致。
embedding_model = os.getenv("EMBEDDING_MODEL", "embedding-3")
dimensions = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))
collection_name = os.getenv("MILVUS_COLLECTION", "agent_course_chunks")
supported_dimensions = {256, 512, 1024, 2048}

# 只读取 Python 版本上一节生成的 chunks.json，不依赖 Node 目录。
lesson_dir = Path(__file__).resolve().parent
chunks_file = lesson_dir.parent / "04-document-chunking" / "output" / "chunks.json"

EmbeddingRequester = Callable[[dict[str, Any], str], dict[str, Any]]
EmbeddingCreator = Callable[[list[str]], list[list[float]]]
ClientFactory = Callable[[], Any]


def normalize_milvus_uri(address: str) -> str:
    """把 localhost:19530 转换成 PyMilvus 接受的 HTTP URI。"""
    return address if "://" in address else f"http://{address}"


def create_client() -> MilvusClient:
    """创建兼容本地 Milvus 和 Zilliz Cloud 的客户端。"""
    address = os.getenv("MILVUS_ADDRESS", "http://localhost:19530")
    token = (os.getenv("MILVUS_TOKEN") or "").strip()
    options: dict[str, Any] = {"uri": normalize_milvus_uri(address)}

    # 本地 Milvus 默认不需要 token；Zilliz Cloud 则需要传入 token。
    if token:
        options["token"] = token

    return MilvusClient(**options)


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
            "model": embedding_model,
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


def read_chunks(path: Path = chunks_file) -> list[dict[str, Any]]:
    """读取 Python 版本上一节生成的 Chunk。"""
    return json.loads(path.read_text(encoding="utf-8"))


def build_collection_schema() -> tuple[Any, Any]:
    """创建与 Node 版本等价的 Collection Schema 和向量索引。"""
    schema = MilvusClient.create_schema(
        auto_id=False,
        enable_dynamic_field=False,
    )

    # Chunk ID 作为主键，Milvus 不自动生成 ID。
    schema.add_field(
        field_name="chunk_id",
        datatype=DataType.VARCHAR,
        is_primary=True,
        max_length=256,
    )

    # 正文和元信息用于检索后展示、过滤和版本更新。
    schema.add_field(
        field_name="content", datatype=DataType.VARCHAR, max_length=4096
    )
    schema.add_field(
        field_name="source", datatype=DataType.VARCHAR, max_length=512
    )
    schema.add_field(
        field_name="title", datatype=DataType.VARCHAR, max_length=512
    )
    schema.add_field(
        field_name="category", datatype=DataType.VARCHAR, max_length=128
    )
    schema.add_field(
        field_name="owner", datatype=DataType.VARCHAR, max_length=128
    )
    schema.add_field(
        field_name="source_version",
        datatype=DataType.VARCHAR,
        max_length=128,
    )
    schema.add_field(field_name="chunk_index", datatype=DataType.INT32)
    schema.add_field(
        field_name="content_hash",
        datatype=DataType.VARCHAR,
        max_length=128,
    )

    # embedding 是真正参与向量检索的字段，维度必须和 API 返回值一致。
    schema.add_field(
        field_name="embedding",
        datatype=DataType.FLOAT_VECTOR,
        dim=dimensions,
    )

    # AUTOINDEX 让 Milvus 选择索引实现，COSINE 用来衡量文本向量相似度。
    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(
        field_name="embedding",
        index_type="AUTOINDEX",
        metric_type="COSINE",
    )
    return schema, index_params


def ensure_collection(client: Any) -> None:
    """确保 Collection、字段和向量索引已经就绪。"""
    exists = client.has_collection(collection_name=collection_name)

    if exists:
        if os.getenv("RESET_COLLECTION") == "true":
            # 开发调试时可以删除旧 Collection，避免旧数据影响实验。
            client.drop_collection(collection_name=collection_name)
        else:
            client.load_collection(collection_name=collection_name)
            return

    schema, index_params = build_collection_schema()
    client.create_collection(
        collection_name=collection_name,
        schema=schema,
        index_params=index_params,
    )
    client.load_collection(collection_name=collection_name)


def to_row(chunk: dict[str, Any], embedding: list[float]) -> dict[str, Any]:
    """把 Chunk 和向量转换成可以写入 Milvus 的一行数据。"""
    metadata = chunk["metadata"]
    return {
        "chunk_id": chunk["chunkId"],
        "content": chunk["content"],
        "source": metadata["source"],
        "title": metadata["title"],
        "category": metadata["category"],
        "owner": metadata["owner"],
        "source_version": metadata["sourceVersion"],
        "chunk_index": metadata["chunkIndex"],
        "content_hash": metadata["contentHash"],
        "embedding": embedding,
    }


def insert_chunks(
    client: Any,
    chunks: list[dict[str, Any]],
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> int:
    """生成向量、批量写入、flush，并重新加载 Collection。"""
    embeddings = embedding_creator([chunk["content"] for chunk in chunks])
    rows = [
        to_row(chunk, embeddings[index])
        for index, chunk in enumerate(chunks)
    ]

    client.insert(collection_name=collection_name, data=rows)
    client.flush(collection_name=collection_name)
    client.load_collection(collection_name=collection_name)
    return len(rows)


def normalize_search_results(raw_results: Any) -> list[dict[str, Any]]:
    """把 PyMilvus 的嵌套 hit/entity 结构整理成课程统一格式。"""
    if not raw_results:
        return []

    # 一次只查询一个向量，因此取第一组 hits。
    hits = raw_results[0] if isinstance(raw_results[0], list) else raw_results
    results: list[dict[str, Any]] = []

    for hit in hits:
        entity = dict(hit.get("entity") or {})
        entity.setdefault("chunk_id", hit.get("id"))
        entity["score"] = hit.get("distance", hit.get("score", 0))
        results.append(entity)
    return results


def search_question(
    client: Any,
    question: str,
    filter_expression: str,
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> list[dict[str, Any]]:
    """生成问题向量，并使用 Metadata Filter 检索 Top 3。"""
    query_vector = embedding_creator([question])[0]
    raw_results = client.search(
        collection_name=collection_name,
        anns_field="embedding",
        data=[query_vector],
        limit=3,
        filter=filter_expression,
        output_fields=[
            "chunk_id",
            "content",
            "source",
            "title",
            "category",
            "owner",
            "source_version",
            "chunk_index",
            "content_hash",
        ],
        search_params={"metric_type": "COSINE"},
    )
    return normalize_search_results(raw_results)


def print_search_results(results: list[dict[str, Any]]) -> None:
    """打印排名、相似度、来源版本和内容预览。"""
    for index, item in enumerate(results, start=1):
        print(
            {
                "rank": index,
                "score": f"{float(item['score']):.6f}",
                "chunk_id": item.get("chunk_id") or item.get("id"),
                "title": item.get("title"),
                "category": item.get("category"),
                "source_version": item.get("source_version"),
                "content": str(item.get("content", ""))[:60],
            }
        )


def hash_text(text: str) -> str:
    """返回 UTF-8 SHA-256 的前 12 位。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def create_updated_refund_chunks() -> list[dict[str, Any]]:
    """构造阈值改为 5000 元的 2026-07-01 版退款规则。"""
    version = "2026-07-01"
    chunks = [
        {
            "content": """# 蓝鲸退款规则

普通商品签收后 7 天内可以申请退款。

生鲜商品不支持无理由退款。

退款金额超过 5000 元时，需要进入人工审核流程。

用户提交退款申请后，系统会先校验订单状态、签收时间和商品类型。""",
            "chunkIndex": 1,
        },
        {
            "content": """如果订单命中人工审核规则，退款申请会进入客服审核队列。

客服审核通过后，系统再进入退款打款流程。""",
            "chunkIndex": 2,
        },
    ]

    results: list[dict[str, Any]] = []
    for chunk in chunks:
        content_hash = hash_text(chunk["content"])
        chunk_id = (
            f"refund-policy:{version}:{chunk['chunkIndex']:03d}:"
            f"{content_hash}"
        )
        results.append(
            {
                "chunkId": chunk_id,
                "content": chunk["content"],
                "metadata": {
                    "source": "refund-policy.md",
                    "title": "蓝鲸退款规则",
                    "category": "refund",
                    "owner": "customer-service",
                    "sourceVersion": version,
                    "chunkIndex": chunk["chunkIndex"],
                    "contentHash": content_hash,
                    "chunkLength": len(chunk["content"]),
                },
            }
        )
    return results


def setup_command(
    client_factory: ClientFactory = create_client,
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> int:
    """创建 Collection，并写入上一节生成的全部 Chunk。"""
    client = client_factory()
    ensure_collection(client)
    count = insert_chunks(client, read_chunks(), embedding_creator)
    print(f"已写入 Chunk 数量：{count}")
    return count


def search_command(
    client_factory: ClientFactory = create_client,
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> list[dict[str, Any]]:
    """只在 refund 分类中检索 3000 元退款问题。"""
    client = client_factory()
    ensure_collection(client)
    question = "3000 元退款需要人工审核吗？"
    filter_expression = 'category == "refund"'

    print(f"用户问题：{question}")
    print(f"Metadata Filter：{filter_expression}")
    results = search_question(
        client,
        question,
        filter_expression,
        embedding_creator,
    )
    print_search_results(results)
    return results


def update_refund_rule(
    client_factory: ClientFactory = create_client,
    embedding_creator: EmbeddingCreator = create_embeddings,
) -> dict[str, Any]:
    """删除旧退款 Chunk、写入新版规则，并再次检索。"""
    client = client_factory()
    ensure_collection(client)

    # 按 source 删除 refund-policy.md 下的全部旧版本 Chunk。
    client.delete(
        collection_name=collection_name,
        filter='source == "refund-policy.md"',
    )

    updated_chunks = create_updated_refund_chunks()
    count = insert_chunks(client, updated_chunks, embedding_creator)
    print(f"退款规则已更新，新写入 Chunk 数量：{count}")

    question = "3000 元退款需要人工审核吗？"
    results = search_question(
        client,
        question,
        'category == "refund"',
        embedding_creator,
    )
    print(f"更新后再次检索：{question}")
    print_search_results(results)
    return {"count": count, "chunks": updated_chunks, "results": results}


def main(argv: list[str] | None = None) -> int:
    """从命令行执行 setup、search 或 update。"""
    arguments = argv if argv is not None else sys.argv[1:]
    action = arguments[0] if arguments else None

    try:
        if action == "setup":
            setup_command()
        elif action == "search":
            search_command()
        elif action == "update":
            update_refund_rule()
        else:
            print(
                "请执行：uv run python milvus_rag_store.py "
                "setup|search|update"
            )
    except (RuntimeError, ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

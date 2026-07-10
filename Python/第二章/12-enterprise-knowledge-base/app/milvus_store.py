"""Milvus / Zilliz 存储访问层。"""

from __future__ import annotations

import re
from typing import Any

from app.config import AppConfig, load_config
from app.filtering import build_permission_filter
from app.models import DemoUser, RetrievedChunk


OUTPUT_FIELDS = [
    "chunk_id",
    "tenant_id",
    "document_id",
    "version",
    "chunk_index",
    "is_active",
    "department_id",
    "visibility",
    "title",
    "source_path",
    "checksum",
    "content",
    "updated_at",
]


def normalize_milvus_uri(address: str) -> str:
    """规范化本地地址，并把 localhost 替换成 127.0.0.1。"""

    normalized = re.sub(
        r"(^|://)localhost(?=:\d+$)",
        r"\g<1>127.0.0.1",
        address.strip(),
    )
    return normalized if "://" in normalized else f"http://{normalized}"


def load_pymilvus() -> dict[str, Any]:
    """延迟导入 PyMilvus，方便离线测试不依赖外部服务。"""

    try:
        from pymilvus import (  # type: ignore[import-not-found]
            AnnSearchRequest,
            DataType,
            Function,
            FunctionType,
            MilvusClient,
            RRFRanker,
        )
    except ImportError as error:
        raise RuntimeError("请先执行 uv sync 安装 PyMilvus。") from error

    return {
        "AnnSearchRequest": AnnSearchRequest,
        "DataType": DataType,
        "Function": Function,
        "FunctionType": FunctionType,
        "MilvusClient": MilvusClient,
        "RRFRanker": RRFRanker,
    }


def build_collection_schema(dimensions: int) -> tuple[Any, Any]:
    """创建或加载企业知识库 Collection。

    Collection 同时包含权限、版本、Dense 向量和 BM25 稀疏向量字段。
    """

    pymilvus = load_pymilvus()
    data_type = pymilvus["DataType"]
    function = pymilvus["Function"]
    function_type = pymilvus["FunctionType"]
    milvus_client = pymilvus["MilvusClient"]

    schema = milvus_client.create_schema(
        auto_id=False,
        enable_dynamic_field=False,
    )
    # Chunk ID 是主键，tenant_id 作为 Partition Key 参与租户路由。
    schema.add_field(
        field_name="chunk_id",
        datatype=data_type.VARCHAR,
        is_primary=True,
        max_length=256,
    )
    schema.add_field(
        field_name="tenant_id",
        datatype=data_type.VARCHAR,
        max_length=64,
        is_partition_key=True,
    )
    schema.add_field(
        field_name="document_id", datatype=data_type.VARCHAR, max_length=64
    )
    schema.add_field(field_name="version", datatype=data_type.INT32)
    schema.add_field(field_name="chunk_index", datatype=data_type.INT32)
    schema.add_field(field_name="is_active", datatype=data_type.BOOL)
    schema.add_field(
        field_name="department_id", datatype=data_type.VARCHAR, max_length=64
    )
    schema.add_field(
        field_name="visibility", datatype=data_type.VARCHAR, max_length=32
    )
    schema.add_field(
        field_name="title", datatype=data_type.VARCHAR, max_length=256
    )
    schema.add_field(
        field_name="source_path", datatype=data_type.VARCHAR, max_length=512
    )
    schema.add_field(
        field_name="checksum", datatype=data_type.VARCHAR, max_length=64
    )
    schema.add_field(
        field_name="content",
        datatype=data_type.VARCHAR,
        max_length=8192,
        enable_analyzer=True,
        enable_match=True,
        analyzer_params={
            # 中文 BM25 使用 jieba 分词，并移除单独的标点 Token。
            "tokenizer": "jieba",
            "filter": ["removepunct"],
        },
    )
    schema.add_field(
        field_name="dense_vector",
        datatype=data_type.FLOAT_VECTOR,
        dim=dimensions,
    )
    schema.add_field(
        field_name="sparse_vector",
        datatype=data_type.SPARSE_FLOAT_VECTOR,
    )
    schema.add_field(field_name="updated_at", datatype=data_type.INT64)

    # Milvus 根据 content 自动生成 sparse_vector，应用层无需手动计算。
    schema.add_function(
        function(
            name="content_bm25",
            function_type=function_type.BM25,
            input_field_names=["content"],
            output_field_names=["sparse_vector"],
            params={},
        )
    )

    index_params = milvus_client.prepare_index_params()
    index_params.add_index(
        field_name="dense_vector",
        index_type="AUTOINDEX",
        metric_type="COSINE",
    )
    index_params.add_index(
        field_name="sparse_vector",
        index_type="SPARSE_INVERTED_INDEX",
        metric_type="BM25",
        params={"inverted_index_algo": "DAAT_MAXSCORE"},
    )
    return schema, index_params


def normalize_search_results(raw_results: Any) -> list[dict[str, Any]]:
    """把 PyMilvus 的嵌套 hit/entity 结构整理成课程统一格式。"""

    if not raw_results:
        return []
    hits = raw_results[0] if isinstance(raw_results[0], list) else raw_results
    rows: list[dict[str, Any]] = []
    for hit in hits:
        entity = dict(hit.get("entity") or {})
        entity.setdefault("chunk_id", hit.get("id"))
        entity["score"] = hit.get("distance", hit.get("score", 0))
        rows.append(entity)
    return rows


class MilvusStore:
    """企业知识库对 Milvus 的所有访问都集中在这一层。"""

    def __init__(
        self, config: AppConfig | None = None, client: Any | None = None
    ):
        self.config = config or load_config()
        self.collection_name = self.config.milvus_collection
        self.dimensions = self.config.embedding_dimensions
        self.client = client or self._create_client()

    def _create_client(self) -> Any:
        """创建兼容本地 Milvus 和 Zilliz Cloud 的客户端。"""

        pymilvus = load_pymilvus()
        options: dict[str, Any] = {
            "uri": normalize_milvus_uri(self.config.milvus_address)
        }
        if self.config.milvus_token:
            options["token"] = self.config.milvus_token
        return pymilvus["MilvusClient"](**options)

    def close(self) -> None:
        """应用退出时主动关闭 Milvus 连接。"""

        close = getattr(self.client, "close", None)
        if callable(close):
            close()

    def ensure_collection(self) -> None:
        """确保 Collection、字段、BM25 Function 和索引已经就绪。"""

        exists = self.client.has_collection(collection_name=self.collection_name)
        if not exists:
            schema, index_params = build_collection_schema(self.dimensions)
            self.client.create_collection(
                collection_name=self.collection_name,
                schema=schema,
                index_params=index_params,
                num_partitions=16,
            )
        self.client.load_collection(collection_name=self.collection_name)

    def query(
        self, filter_expression: str, limit: int = 5000
    ) -> list[dict[str, Any]]:
        """根据 Metadata Filter 查询 Chunk 数据。"""

        return list(
            self.client.query(
                collection_name=self.collection_name,
                filter=filter_expression,
                output_fields=OUTPUT_FIELDS,
                limit=limit,
            )
            or []
        )

    def insert_chunks(self, rows: list[dict[str, Any]]) -> None:
        """批量写入新版本 Chunk，并等待数据进入持久化存储。"""

        result = self.client.insert(
            collection_name=self.collection_name,
            data=rows,
        )
        self._ensure_ok(result, "写入新版本 Chunk")
        self.client.flush(collection_name=self.collection_name)

    def set_active(
        self,
        rows: list[dict[str, str]],
        is_active: bool,
    ) -> None:
        """通过 Partial Upsert 切换一组 Chunk 的生效状态。"""

        if not rows:
            return

        result = self.client.upsert(
            collection_name=self.collection_name,
            data=[
                {
                    "chunk_id": row["chunkId"],
                    "tenant_id": row["tenantId"],
                    "is_active": is_active,
                }
                for row in rows
            ],
            partial_update=True,
        )
        self._ensure_ok(result, "切换文档版本状态")
        self.client.flush(collection_name=self.collection_name)

    def hybrid_search(
        self,
        user: DemoUser,
        question: str,
        query_vector: list[float],
        limit: int = 8,
    ) -> dict[str, object]:
        """在用户权限范围内执行 Dense + BM25 混合检索。"""

        pymilvus = load_pymilvus()
        ann_search_request = pymilvus["AnnSearchRequest"]
        rrf_ranker = pymilvus["RRFRanker"]

        # 权限必须在召回前生效，不能等候选资料返回后再由应用层过滤。
        filter_expression = build_permission_filter(user)
        requests = [
            ann_search_request(
                data=[query_vector],
                anns_field="dense_vector",
                param={},
                limit=12,
                expr=filter_expression,
            ),
            ann_search_request(
                data=[question],
                anns_field="sparse_vector",
                param={},
                limit=12,
                expr=filter_expression,
            ),
        ]
        raw_results = self.client.hybrid_search(
            collection_name=self.collection_name,
            reqs=requests,
            ranker=rrf_ranker(60),
            limit=limit,
            output_fields=OUTPUT_FIELDS,
        )

        rows = normalize_search_results(raw_results)
        return {
            "filter": filter_expression,
            "chunks": [self.to_retrieved_chunk(row) for row in rows],
        }

    def to_retrieved_chunk(self, row: dict[str, Any]) -> RetrievedChunk:
        """把 Milvus 原始搜索结果转换成业务统一的 Chunk 结构。"""

        return RetrievedChunk(
            chunk_id=str(row.get("chunk_id") or row.get("id")),
            tenant_id=str(row.get("tenant_id")),
            document_id=str(row.get("document_id")),
            version=int(row.get("version") or 0),
            chunk_index=int(row.get("chunk_index") or 0),
            department_id=str(row.get("department_id")),
            visibility=row.get("visibility"),  # type: ignore[arg-type]
            title=str(row.get("title")),
            source_path=str(row.get("source_path")),
            checksum=str(row.get("checksum")),
            content=str(row.get("content")),
            retrieval_score=float(row.get("score") or 0),
        )

    def _ensure_ok(self, response: Any, action: str) -> None:
        """检查 Milvus SDK 返回状态，并把失败操作转换成明确异常。"""

        if response is None:
            return
        status = response.get("status", response) if isinstance(response, dict) else {}
        code = int(status.get("code", 0)) if isinstance(status, dict) else 0
        error_code = status.get("error_code") if isinstance(status, dict) else None

        if code != 0 or (error_code and error_code != "Success"):
            raise RuntimeError(f"{action}失败：{status}")


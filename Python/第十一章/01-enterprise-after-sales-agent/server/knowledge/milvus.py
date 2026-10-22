"""Dense + BM25 → RRF(60) → Rerank；两路均先过滤，再核对目录 Hash。"""

import asyncio
import math
import os
from ..common import dumps, require
from ..config import Config
from ..providers import JsonHttp
from .catalog import policy_hash

# PyMilvus 的配置模块会隐式调用 python-dotenv；本项目只接受进程配置。
# 使用 python-dotenv 官方开关，在导入 SDK 以前禁用自动发现与加载。
os.environ["PYTHON_DOTENV_DISABLED"] = "1"


def policy_filter(tenant, category=None):
    return f"tenant_id == {dumps(tenant)} and is_active == true" + (f" and category == {dumps(category)}" if category else "")


class ZhipuRanking:
    def __init__(self, config=None, http=None):
        self.config, self.http = config or Config(), http or JsonHttp()
        self.dimensions = int(self.config.value("EMBEDDING_DIMENSIONS", "512"))
        require(self.dimensions in (256, 512, 1024, 2048), "EMBEDDING_DIMENSIONS 必须为 256/512/1024/2048")

    async def post(self, path, body):
        key = self.config.value("ZHIPU_API_KEY")
        require(key, "Milvus 检索需要配置 ZHIPU_API_KEY")
        return await self.http.json(self.config.value("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4").rstrip("/") + "/" + path, body, key, timeout=30)

    async def embed(self, texts):
        output = []
        for i in range(0, len(texts), 64):
            batch = texts[i:i+64]
            body = await self.post("embeddings", {"model": self.config.value("EMBEDDING_MODEL", "embedding-3"), "input": batch, "dimensions": self.dimensions})
            rows = sorted(body.get("data", []), key=lambda r: r["index"])
            require(len(rows) == len(batch) and all(r["index"] == j and len(r["embedding"]) == self.dimensions and all(type(n) in (int, float) and math.isfinite(n) for n in r["embedding"]) for j, r in enumerate(rows)), "Embedding 返回数量、下标或向量维度不匹配")
            output.extend(r["embedding"] for r in rows)
        return output

    async def rerank(self, query, docs):
        body = await self.post("rerank", {"model": self.config.value("RERANK_MODEL", "rerank"), "query": query,
            "documents": [p["title"] + "\n" + p["content"] for p in docs], "top_n": min(3, len(docs)), "return_documents": False})
        indices = [r["index"] for r in body.get("results", [])]
        require(indices and len(set(indices)) == len(indices) and all(type(i) is int and 0 <= i < len(docs) for i in indices), "Rerank 返回了无效文档下标")
        return indices[:3]


class MilvusPolicies:
    def __init__(self, client, ranking, config=None):
        self.client, self.ranking, self.config = client, ranking, config or Config()
        self.collection = self.config.value("AFTERSALES_POLICY_COLLECTION", "aftersales_policies_v1")
        self.dimensions = int(self.config.value("EMBEDDING_DIMENSIONS", "512"))

    @classmethod
    def connect(cls, config=None):
        from pymilvus import MilvusClient
        config = config or Config()
        address = config.value("MILVUS_ADDRESS", "127.0.0.1:19530")
        client = MilvusClient(uri=address if "://" in address else "http://" + address, token=config.value("MILVUS_TOKEN"), timeout=30)
        return cls(client, ZhipuRanking(config), config)

    async def index(self, catalog):
        from pymilvus import MilvusClient, DataType, Function, FunctionType
        if not await asyncio.to_thread(self.client.has_collection, collection_name=self.collection):
            schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=False)
            for name, length in [("key", 256), ("policy_id", 128), ("tenant_id", 128), ("category", 32), ("checksum", 64)]:
                schema.add_field(name, DataType.VARCHAR, max_length=length, is_primary=name == "key")
            schema.add_field("is_active", DataType.BOOL)
            schema.add_field("version", DataType.INT32)
            schema.add_field("content", DataType.VARCHAR, max_length=32768, enable_analyzer=True, analyzer_params={"tokenizer": "jieba", "filter": ["removepunct"]})
            schema.add_field("dense_vector", DataType.FLOAT_VECTOR, dim=self.dimensions)
            schema.add_field("sparse_vector", DataType.SPARSE_FLOAT_VECTOR)
            schema.add_function(Function(name="content_bm25", function_type=FunctionType.BM25, input_field_names=["content"], output_field_names=["sparse_vector"]))
            indexes = MilvusClient.prepare_index_params()
            indexes.add_index(field_name="dense_vector", index_type="AUTOINDEX", metric_type="COSINE")
            indexes.add_index(field_name="sparse_vector", index_type="SPARSE_INVERTED_INDEX", metric_type="BM25")
            await asyncio.to_thread(self.client.create_collection, collection_name=self.collection, schema=schema, index_params=indexes)
        vectors = await self.ranking.embed([p["title"] + "\n" + p["content"] for p in catalog])
        rows = [dict(key=f"{p['tenantId']}:{p['id']}", policy_id=p["id"], tenant_id=p["tenantId"], category=p["category"],
            version=p["version"], is_active=p["active"], checksum=policy_hash(p), content=p["title"]+"\n"+p["content"], dense_vector=v) for p, v in zip(catalog, vectors)]
        await asyncio.to_thread(self.client.upsert, collection_name=self.collection, data=rows)
        await asyncio.to_thread(self.client.flush, collection_name=self.collection)
        await asyncio.to_thread(self.client.load_collection, collection_name=self.collection)

    async def search(self, query, tenant, category, catalog):
        from pymilvus import AnnSearchRequest, RRFRanker
        filter = policy_filter(tenant, category)
        vector = (await self.ranking.embed([query]))[0]
        # Python SDK 返回每个 query 的 hits，标量字段位于 entity 中。
        response = await asyncio.to_thread(self.client.hybrid_search, collection_name=self.collection,
            reqs=[AnnSearchRequest(data=[vector], anns_field="dense_vector", param={"metric_type": "COSINE"}, limit=12, expr=filter),
                  AnnSearchRequest(data=[query], anns_field="sparse_vector", param={"metric_type": "BM25"}, limit=12, expr=filter)],
            ranker=RRFRanker(60), limit=8, output_fields=["policy_id", "tenant_id", "version", "category", "is_active", "checksum"])
        unique = {}
        for hit in response[0] if response else []:
            row = hit.get("entity", hit)
            p = next((p for p in catalog if p["id"] == row.get("policy_id") and p["tenantId"] == tenant and p["active"] and (not category or p["category"] == category)), None)
            if p and row.get("tenant_id") == tenant and row.get("is_active") is True and row.get("version") == p["version"] and row.get("checksum") == policy_hash(p):
                unique[p["id"]] = p
        candidates = list(unique.values())
        if not candidates:
            return []
        indices = await self.ranking.rerank(query, candidates)
        return [candidates[i] for i in indices]

    async def close(self):
        await asyncio.to_thread(self.client.close)

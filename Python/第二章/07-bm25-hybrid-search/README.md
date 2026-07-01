# BM25 与混合检索

这个示例在同一个 Milvus Collection 中同时使用 Dense 向量检索和 BM25 全文检索，并对比 Weighted、RRF 两种融合方式的 Recall@3。

## 安装依赖

```bash
uv sync
```

Python 版本使用 `pymilvus==2.6.12`，对应课程中的 Milvus 2.6.x。

## 启动本地 Milvus

```bash
cp .env.example .env
docker compose up -d --wait --wait-timeout 180
```

在 `.env` 中填写 `ZHIPU_API_KEY`。如果使用 Zilliz Cloud，再修改 `MILVUS_ADDRESS` 和 `MILVUS_TOKEN`。

## 导入环境变量并运行

```bash
set -a
source .env
set +a
uv run python hybrid_search.py
```

程序会重建专用 Collection，写入 8 份测试文档，并输出 Dense、BM25、Weighted 和 RRF 在三个问题上的 Recall@3。

> 每次运行都会删除并重建 `MILVUS_COLLECTION` 指定的 Collection。请不要填写生产 Collection 名称。

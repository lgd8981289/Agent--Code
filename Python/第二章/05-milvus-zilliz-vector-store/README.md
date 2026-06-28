# Milvus / Zilliz 向量库存储

这个示例读取上一节生成的 `chunks.json`，写入 Milvus，并演示 Metadata Filter 检索以及退款规则版本更新。

## 安装 Python 依赖

```bash
uv sync
```

当前 Docker Compose 使用 Milvus 2.6.x，因此固定使用 `pymilvus==2.6.12`。

## 启动本地 Milvus

```bash
cp .env.example .env
docker compose up -d
```

在 `.env` 中填写 `ZHIPU_API_KEY`。如果使用 Zilliz Cloud，还需要修改 `MILVUS_ADDRESS` 并填写 `MILVUS_TOKEN`。

## 导入环境变量

在当前小节目录执行：

```bash
set -a
source .env
set +a
```

Python 标准解释器不会自动读取 `.env`，所以运行命令前必须完成这一步。

## 初始化、检索和更新

```bash
uv run python milvus_rag_store.py setup
uv run python milvus_rag_store.py search
uv run python milvus_rag_store.py update
```

- `setup`：创建 Collection，并写入第四节生成的 Chunk。
- `search`：使用 `category == "refund"` 过滤条件检索退款资料。
- `update`：删除旧退款规则，写入 2026-07-01 版本并再次检索。

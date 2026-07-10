# 企业知识库实战 Python 版

这是第二章的综合项目 Python 版本，包含 FastAPI 后端、静态前端、Milvus 混合检索、文档版本更新、权限隔离、Rerank、来源引用和拒答。

## 代码结构

- `app/main.py`：FastAPI 入口，提供 `/api` 接口并托管静态前端。
- `app/document_service.py`：文档分块、checksum 去重、版本切换和软删除。
- `app/knowledge_service.py`：问题向量化、Hybrid Search、Rerank、答案生成和来源绑定。
- `app/ai_service.py`：调用智谱 Embedding、Rerank 和 Chat API。
- `app/milvus_store.py`：创建 Milvus Collection，执行 Dense + BM25 混合检索。
- `sample_documents/`：跨租户、跨部门样例文档。
- `scripts/doctor.py`、`scripts/seed.py`：运行环境检查和样例数据导入。

## 安装依赖

从当前小节目录执行：

```bash
uv sync
```

当前 Docker Compose 使用 Milvus 2.6.x，因此 Python SDK 与前面小节保持一致，固定使用 `pymilvus==2.6.12`。

## 启动 Milvus

```bash
docker compose up -d --wait --wait-timeout 180
```

## 导入环境变量

Python 标准解释器不会自动读取 `.env`。如果你已经有自己的 `.env`，先在当前 shell 中加载：

```bash
set -a
source .env
set +a
```

程序会读取这些变量：`ZHIPU_API_KEY`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`RERANK_MODEL`、`CHAT_MODEL`、`MILVUS_ADDRESS`、`MILVUS_COLLECTION`、`MILVUS_TOKEN`、`STORAGE_ROOT`、`PORT`。

## 检查、导入和启动

```bash
uv run python scripts/doctor.py
uv run python scripts/seed.py
uv run uvicorn app.main:app --reload --port 3000
```

打开 <http://localhost:3000>。

项目不会自动重置 Collection。重复执行 `scripts/seed.py` 时，内容与权限没有变化的文档会跳过向量化。

## 离线验证

不调用真实 API、不启动 Milvus 时，可以运行离线单元测试：

```bash
python3 -m unittest discover -s tests
```


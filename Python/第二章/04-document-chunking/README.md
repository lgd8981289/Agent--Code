# 文档分块与检索对比

这个小节包含两个独立脚本：

- `build_chunks.py`：读取 `documents/` 中的 Markdown，生成带 Metadata、稳定 ID 和 overlap 的 Chunk，并写入 `output/chunks.json`。
- `memory_vector_search.py`：对比“整篇文档检索”和“分块后检索”返回的上下文长度与精确度。

## 生成 Chunk

```bash
python3 build_chunks.py
```

预期读取两份 Markdown，生成四个 Chunk。

## 运行向量检索对比

```bash
cp .env.example .env
set -a
source .env
set +a
python3 memory_vector_search.py
```

填写 `.env` 中的 `ZHIPU_API_KEY` 后再运行。代码只使用 Python 标准库，不需要安装第三方依赖。

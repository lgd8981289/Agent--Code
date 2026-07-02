# Rerank 与 Context Compression

这个示例先使用 Rerank 模型对检索阶段召回的候选 Chunk 重新排序，再让 Chat 模型只选择能够支持答案的原句，生成更短、更聚焦的最终上下文。

## 代码结构

- `candidate_documents.py`：提供用户问题和 6 条模拟候选资料。
- `rerank_demo.py`：只演示候选资料的 Rerank 排序。
- `rerank_and_compress.py`：在 Rerank 后继续执行抽取式 Context Compression，并输出压缩前后的字符数。

代码只使用 Python 标准库，要求 Python 3.11 或更高版本，不需要安装第三方依赖。

## 运行 Rerank 演示

从当前小节目录执行：

```bash
set -a
source .env
set +a
python3 rerank_demo.py
```

程序会先输出原始候选资料，再根据 Rerank 相关性分数输出 Top4。

## 运行 Rerank 与上下文压缩

```bash
set -a
source .env
set +a
python3 rerank_and_compress.py
```

程序需要 `ZHIPU_API_KEY`。`RERANK_MODEL` 可选，默认使用 `rerank`；`CHAT_MODEL` 可选，默认使用 `glm-4.7-flash`。

最终输出应该包含 Rerank 后的 Top4、压缩前后字符数，以及只由候选原句组成的最终上下文。压缩过程不会让模型改写或总结原文，而是让模型返回句子 ID，再由程序取回对应原句。

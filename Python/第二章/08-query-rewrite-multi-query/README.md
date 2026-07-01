# Query Rewrite 与 Multi-Query

这个示例先把依赖会话上下文的口语化问题改写成一条完整查询，再从业务规则、判断条件和处理流程等不同角度生成 3 条查询，提高知识库检索的召回率。

## 代码结构

- `query_optimizer.py`：构造提示词、调用智谱 Chat Completions API、校验 JSON 结果并输出 Query Rewrite 和 Multi-Query。

代码只使用 Python 标准库，要求 Python 3.11 或更高版本，不需要安装第三方依赖。

## 离线检查

```bash
python3 -m py_compile query_optimizer.py
```

## 调用真实智谱 API

从当前小节目录执行：

```bash
set -a
source .env
set +a
python3 query_optimizer.py "这个订单退款要不要人工审核"
```

程序需要 `ZHIPU_API_KEY`。`CHAT_MODEL` 可选，默认使用 `glm-4.7-flash`；`QUERY_CONTEXT` 可选，未配置时使用代码中的订单 A1024 示例上下文。

正常情况下，程序会输出一条可独立理解的 `rewrittenQuery`，以及从不同检索角度生成的 3 条 `multiQueries`。

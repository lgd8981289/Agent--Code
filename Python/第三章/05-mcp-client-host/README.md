# MCP Client 与最小 Host 调用闭环

这个示例展示 Host 如何同时管理两类连接：

- 通过 MCP Client 连接 MCP Server，发现 Tools、Resources 和 Prompts。
- 通过 DeepSeek Chat Completions 调用模型，把 MCP Tools 转成模型可用的 Tool Calling 定义。

## 代码结构

- `host.py`：最小 Host，负责能力发现、工具格式转换、模型调用循环和 MCP Tool 执行调度。
- `deepseek_client.py`：封装 DeepSeek Chat Completions 请求。
- `after_sales_mcp_server.py`：售后 MCP Server，暴露订单查询、退款预检、退款规则和 Prompt。
- `order_system.py`：模拟订单系统和退款规则。
- `refund_policy.py`：退款规则 Resource 内容。

Python 版本使用官方 MCP Python SDK，并固定为 `mcp==1.28.1`。

## 安装依赖

从当前小节目录执行：

```bash
uv sync
```

## 只验证 MCP 能力发现

```bash
uv run python host.py --discover
```

这个模式只连接 MCP Server，读取 Tools、Resources 和 Prompts，不调用模型，也不需要 API Key。

## 调用真实 DeepSeek API

Python 标准解释器不会自动读取 `.env`。如果你已经有自己的 `.env`，先在当前 shell 中加载：

```bash
set -a
source .env
set +a
uv run python host.py
```

程序需要 `DEEPSEEK_API_KEY`。可选环境变量包括：

- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com/chat/completions`
- `DEEPSEEK_MODEL`：默认 `deepseek-v4-flash`

默认问题是：

```text
订单 A1024 是否满足退款条件？如果可以退款，是否需要人工审核？
```


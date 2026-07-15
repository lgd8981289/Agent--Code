# MCP Server 能力：Tools、Resources 与 Prompts

这个示例通过售后场景演示 MCP Server 可以暴露的三类能力：

- `Tools`：可调用的业务动作，例如查询订单、退款预检。
- `Resources`：可读取的业务资料，例如售后退款规则。
- `Prompts`：可复用的任务模板，例如退款审核回复模板。

## 代码结构

- `after_sales_mcp_server.py`：注册 Tools、Resource 和 Prompt，并通过 stdio 提供 MCP Server。
- `verify_client.py`：启动 Server，查看能力，调用 Tool，读取 Resource，获取 Prompt。
- `order_system.py`：模拟企业订单系统和退款预检规则。
- `refund_policy.py`：提供退款规则 Resource 内容。

Python 版本使用官方 MCP Python SDK，并固定为 `mcp==1.28.1`。

## 安装依赖

从当前小节目录执行：

```bash
uv sync
```

## 运行验证客户端

```bash
uv run python verify_client.py
```

你会依次看到：

```text
查看 Server 能力
查看 Tools
调用退款预检 Tool
读取 Resource
获取 Prompt
验证未知订单
```

本节不需要模型 API Key，不需要 `.env`，也不会调用外部服务。


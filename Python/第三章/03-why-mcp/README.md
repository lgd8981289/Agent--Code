# 为什么需要 MCP：Host、Client 与 Server

这个示例用最小订单查询案例演示 MCP 的基本分工：

- `host.py`：Host，代表售后 Agent 的调度逻辑，内部创建 MCP Client。
- `order_mcp_server.py`：MCP Server，对外暴露 `get_order` 工具。
- `order_system.py`：模拟企业内部订单系统，真实业务能力不直接暴露给 Host。

Node 版本使用官方 `@modelcontextprotocol/sdk`。Python 版本使用官方 Python SDK，并固定为 `mcp==1.28.1`，避免课程代码受到 v2 预发布变动影响。

## 安装依赖

从当前小节目录执行：

```bash
uv sync
```

## 运行示例

```bash
uv run python host.py
```

你会看到完整流程：

```text
Host 启动
Client 建立连接
Client 发现 Server 工具
Host 发起 get_order 调用
Server 返回订单数据
```

本节不需要模型 API Key，不需要 `.env`，也不会调用外部服务。


# MCP 扩展能力：Elicitation 与多轮请求

这个示例展示 MCP 2.0 扩展能力如何协同工作：Tool 首次调用返回 `input_required`，Host 根据 JSON Schema 收集用户确认，Client 携带 `inputResponses` 自动重试同一个 Tool。任务创建后，Host 再通过另一个 Tool 轮询后台审核进度。

## 代码结构

- `refund_review_mcp_server.py`：暴露批量退款审核和状态查询 Tool，处理 `InputRequiredResult`、用户确认结果及后台任务状态。
- `host.py`：通过 stdio 启动 Server，处理 Elicitation 表单请求并轮询审核任务。

本节使用官方 MCP Python SDK 的 2.0 预发布版本，并精确固定为 `mcp==2.0.0b1`，避免预发布 API 自动升级后产生不兼容变化。

## 安装依赖

从当前小节目录执行：

```bash
uv sync
```

## 自动确认并运行完整示例

```bash
uv run python host.py --yes
```

这个命令只会启动本地 Python MCP Server，不调用大模型或外部 API，也不需要任何 Key。

正常情况下可以依次看到：

```text
Host 收集到的确认结果：继续执行
[30%] working：正在读取订单信息
[70%] working：正在检查退款规则
[100%] completed：审核完成
```

## 手动确认

```bash
uv run python host.py
```

输入 `y` 会创建任务并继续轮询；输入其他内容会返回“用户取消了批量退款审核”，且不会创建任务。

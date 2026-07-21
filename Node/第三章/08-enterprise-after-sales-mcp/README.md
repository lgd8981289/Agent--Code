# 企业售后 MCP Server

这是第三章第 08 节的独立实战项目，不依赖第二章知识库项目。

## 运行环境

- Node.js `20.19+`

## 启动

```bash
npm install
npm run build
npm run server
```

`npm run build` 会构建两个页面：

- `build:app`：构建由 MCP Server 以 `ui://` Resource 提供的批量审核 MCP App。
- `build:web-host`：构建用于连续对话和渲染 MCP App 的本地 Web Host。

新开一个终端运行验证 Client：

```bash
npm run verify
```

验证流程不需要模型 API Key。

## 运行 MCP Apps Web Host

保持 MCP Server 运行，再打开一个终端：

```bash
npm run web-host
```

然后访问：

```text
http://127.0.0.1:3200
```

Web Host 提供两种演示方式：

1. 在输入框中连续提问，由 DeepSeek 选择 MCP Tools。
2. 点击“一键演示 MCP App”，不经过模型，直接运行确定性的批量审核链路。

一键演示会自动切换到蓝鲸科技财务身份，显示 Human-in-the-Loop 确认弹窗，并在对话中渲染批量退款审核报告。

MCP App 会运行在独立的 Sandbox Origin：

```text
Web Host：http://127.0.0.1:3200
Sandbox：http://127.0.0.1:3201
MCP Server：http://127.0.0.1:3100/mcp
```

Web Host 的 Node 层负责调用 DeepSeek 和 MCP Server，浏览器不会直接获取 `DEEPSEEK_API_KEY`。

> “一键演示 MCP App”不需要 DeepSeek API Key。只有在输入框中进行自然语言对话时，才会调用 DeepSeek。

## 运行 Agent Host

在项目根目录创建 `.env`：

```dotenv
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
MCP_TOKEN=token-blue-service
REQUEST_STATE_SECRET=请替换为至少32字节的随机字符串
```

然后启动连续对话 Host：

```bash
npm run host
```

Host 只会连接一次 MCP Server，并在同一个进程中持续保存 `messages`。可以连续输入：

```text
用户：订单 A1024 可以退款吗？
Agent：……请问您是否要提交退款申请？

用户：确认退款，因为产品质量不行。
Agent：……
```

输入 `/exit`、`/quit` 或“退出”结束对话。

也可以在启动时直接提供第一个问题：

```bash
npm run host -- "订单 A1024 可以退款吗？"
```

处理完这个问题后，Host 不会退出，而是继续显示 `用户：`，等待下一轮输入。

命令行 Host 适合观察 Tool Calling 和原始 JSON 结果，但不会渲染 MCP App。如果要演示可视化报告，请使用 `npm run web-host`。

## 演示身份

| Token | 企业 | 角色 |
| --- | --- | --- |
| `token-blue-service` | 蓝鲸科技 | 客服 |
| `token-blue-finance` | 蓝鲸科技 | 财务 |
| `token-star-service` | 星河零售 | 客服 |

这些 token 只用于本地演示，不能直接用于生产环境。

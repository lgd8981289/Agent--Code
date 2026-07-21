# 企业售后 MCP Server

这是第三章第 08 节的独立实战项目，不依赖第二章知识库项目。

## 运行环境

- Node.js `20.19+`

## 启动

```bash
npm install
npm run build:app
npm run server
```

新开一个终端运行验证 Client：

```bash
npm run verify
```

验证流程不需要模型 API Key。

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

## 演示身份

| Token | 企业 | 角色 |
| --- | --- | --- |
| `token-blue-service` | 蓝鲸科技 | 客服 |
| `token-blue-finance` | 蓝鲸科技 | 财务 |
| `token-star-service` | 星河零售 | 客服 |

这些 token 只用于本地演示，不能直接用于生产环境。

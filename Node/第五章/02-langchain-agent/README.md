# LangChain 最小 Agent

这个示例使用 LangChain.js、DeepSeek 和一个 `get_order_status` Tool，完成订单状态查询任务。

## 安装

```bash
npm install
```

## 配置

运行前需要让当前进程能读取到：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

如果当前目录已经有你自己的 `.env`，可以直接使用下面的运行命令。

## 运行

```bash
npm start
```

运行时，模型会先提出 `get_order_status` Tool Call。LangChain 执行 Tool，把结果作为 ToolMessage 放回消息状态，再次调用模型并生成最终回答。

## 检查

```bash
npm run check
```


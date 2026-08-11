# LangChain 核心抽象实验

这个案例分别运行 Chat Model、Message、Tool、手动 Tool Calling 和 RunnableSequence，不使用 `createAgent`。

## 安装

```bash
npm install
```

## 配置

真实模型实验需要让当前进程能读取到：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

`tool` 实验不调用模型，因此不需要配置 DeepSeek API Key。

## 运行

```bash
npm run model
npm run stream
npm run tool
npm run calling
npm run runnable
```

其中 `calling` 会手动执行“模型生成 Tool Call、应用程序执行 Tool、ToolMessage 回传、模型生成最终回答”的完整过程。

## 检查

```bash
npm run check
```


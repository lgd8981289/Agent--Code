# LangChain Agent 数据边界

这个案例通过同一个 `DEV-1024` 在两个租户下返回不同任务，演示：

- 用户问题如何进入 Agent State；
- 可信身份如何通过 Runtime Context 进入 Tool；
- Tool 如何使用租户信息隔离数据；
- Agent 如何通过 Structured Output 向后端返回稳定结果；
- 为什么用户在 Prompt 中伪造租户不能改变实际查询范围。

案例使用 `toolStrategy()` 约束最终结果。由于 DeepSeek Thinking 模式不支持
该策略需要的强制 `tool_choice`，本案例会关闭 Thinking，只使用普通模式完成
Tool Calling 和结构化结果生成。

## 安装

```bash
npm install
```

## 配置

在当前目录创建 `.env`：

```dotenv
DEEPSEEK_API_KEY=你的_API_Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

## 运行

```bash
npm run demo
```

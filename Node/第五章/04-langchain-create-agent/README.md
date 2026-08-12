# createAgent Runtime 多轮执行案例

这个案例让 Agent 分别查询研发任务和最新测试报告，再根据两份数据判断任务是否存在延期风险。

第二个 Tool 所需的 `repository` 来自第一个 Tool，因此 Agent 必须经历多轮“模型决策 → Tool 执行 → 结果回传”才能完成任务。

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

这一次执行会同时展示：

- `updates`：Model 和 Tools 每一步完成后的状态更新；
- `messages`：模型生成的最终回答；
- `custom`：Tool 主动发送的查询进度；
- 最终 Message 轨迹：本次 Agent Run 中依次产生的 AIMessage 和 ToolMessage。

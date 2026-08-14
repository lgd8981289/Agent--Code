# LangChain Middleware

这个案例在第五章 05 小节的研发任务风险分析 Agent 上继续增加：

- 根据 Runtime Context 动态过滤 Tool；
- 在 Tool 执行前再次校验角色权限；
- 限制单次 Agent Run 的模型与 Tool 调用次数；
- 校验 Tool 返回结果，并对暂时性错误自动重试。

## 安装

```bash
npm install
```

## 配置

在当前目录创建 `.env`，配置 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL`。

## 运行

```bash
npm run demo
```

也可以单独运行某组实验：

```bash
npm run permission
npm run retry
npm run budget
```

# 06-记忆更新与遗忘

使用 Node.js 20.6+，在本目录执行：

```bash
npm install
npm run demo
npm test
```

不需要 API Key、环境变量文件或数据库。案例使用真实 `InMemoryStore`，进程结束后数据消失。

入口是 `memory-lifecycle.js` 的 `main()`，固定候选在 `scenarios.js`，维护规则在 `memory-manager.js`。

案例承接上一节**候选已经完成提取和审核**的位置。候选拆成固定画像字段；演示里的字段和确认结果是预设数据，没有调用提取模型，也没有实际的确认页面。`confirmedRevision` 模拟应用收到的用户确认，不能让模型自行生成。

运行时逐次打印新增、别名去重、当前会话要求、冲突、确认更新、旧消息重放、有效期、删除和删除后重放的结果。每次都重新读取有效记忆，展示下一次组装模型输入时可用的数据，不调用回答模型。

`now` 使用固定时钟，所以不管哪天运行都能复现到期边界。`expiresAt` 是业务有效期，必须通过 `getActiveMemory()` 或 `recallMemories()` 读取才能过滤；它不是 Store 自动清理功能。

删除时清除记忆正文，同时在独立 Namespace 保留只有 `blockedAt` 的禁止写入标记。本案例持续阻止该字段的自动写入，没有实现重新启用记忆的入口。删除标记不会交给模型。

本例按用户串行处理。生产多进程并发时，读取、版本校验和写入需要事务或条件更新；记录 `revision` 本身并不提供原子性。换成持久化 Store 时，记忆和禁止写入标记应一起持久化。

本例不清除历史消息、摘要、Checkpoint、日志或备份，也没有单独的向量索引。实际删除这些副本和停止已在途的模型请求，需要在各自的数据与执行链路处理。

官方参考（核验于 2026-09-06）：

- [LangGraph Stores](https://docs.langchain.com/oss/javascript/langgraph/stores)
- [LangChain Memory Overview](https://docs.langchain.com/oss/javascript/concepts/memory)

依赖沿用上一节的 `@langchain/langgraph@1.4.13`，API 同时对照安装包中的 `BaseStore` 源码验证。

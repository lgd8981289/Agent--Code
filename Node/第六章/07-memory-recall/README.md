# 07-记忆召回

在本目录安装依赖：

```bash
npm install
```

使用 Node.js 20.6+。在本目录自行配置 `.env`，变量与前面课程一致：

```text
ZHIPU_API_KEY=你的智谱 API Key
EMBEDDING_MODEL=embedding-3
EMBEDDING_DIMENSIONS=512
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

```bash
npm run demo
npm run answer
```

`demo` 真实调用智谱 Embedding，打印回答偏好、历史候选、筛选原因和最终 messages。`answer` 在这条链路后继续调用 DeepSeek，除此以外流程相同。不会生成或修改环境变量文件。

入口为 `memory-recall.js` 的 `main()`。`fixtures.js` 是模拟的当前会话、用户记忆和已核验业务资料；`models.js` 对接智谱与 DeepSeek；`recall.js` 实现读取、筛选和模型输入组装。

使用 `InMemoryStore` 便于独立运行，不需要 Docker 或 PostgreSQL，进程退出后数据消失。每次命令都会重新向量化少量固定资料。真实项目通常在记忆写入、更新时生成向量，查询时仅对问题向量化。

本节采用独立的 `recall-profiles`、`recall-events` 和 `recall-blocks` Namespace，不读取或修改第 04～06 节的已存数据。画像保留上一节的字段级读取思路，事件另外用 `status` 标识旧记录是否已被修正。

`fetchK=10` 是候选数，`topK=3` 是最终历史记忆数上限。`minScore=0.5` 只是示例参数，真实分数和顺序可能变化，需要用实际问答样本校准。教学数据少，先取候选再显示过滤原因；大量数据时，支持的状态、有效期等条件应尽量在检索时过滤，避免无效候选占满 fetchK。

`maxMemoryChars=600` 限制序列化历史记忆数组的字符数，不是 Token 数，也不是整个上下文的预算。当前业务依据、摘要、近期消息还需要统一纳入项目的 Context Budget。本例不截断单条记忆。

当前规则和订单使用模拟的已核验数据，审核判断由代码完成。用户记得的旧规则仍可作为历史陈述，但不能参与当前审核判断。本例没有连接实际订单系统、知识库或退款接口；来源标签和 Prompt 本身也不构成通用的防注入保证。

离线验证：

```bash
npm test
npm run check
```

测试使用固定向量替身，不调用外部 API；真实模型效果需要用 `demo`、`answer` 单独观察。

官方资料（2026-09-06 核验）：

- [LangGraph Stores](https://docs.langchain.com/oss/javascript/langgraph/stores)
- [LangChain Context Engineering](https://docs.langchain.com/oss/javascript/langchain/context-engineering)
- [智谱 Embedding-3](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

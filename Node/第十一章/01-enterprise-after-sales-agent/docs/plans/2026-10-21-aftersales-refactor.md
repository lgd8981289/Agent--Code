# 企业售后 Agent 重构 Implementation Plan

> 执行方式：按 writing-plans / executing-plans 的分步验证方法执行。用户已确认本轮直接实施；不再另开会话或请求重复确认。

**Goal:** 在保留第十一章九个小节和现有退款主线的前提下，使多轮咨询、材料、政策、申请版本、调查和评测使用一致的业务依据。

**Architecture:** 保持 NestJS 模块化单体、Vue 3、MCP 与 PostgreSQL。申请聚合保护状态变更，仓储统一有效材料查询；咨询保存经校验的回答与证据快照，业务事实每次重新查询。知识接口支持本地 BM25 和 Milvus 混合检索，评测通过实际应用入口执行 Replay 或 AI。

**Tech Stack:** TypeScript、NestJS、Vue 3、LangChain、LangGraph、Deep Agents、PostgreSQL、MCP、Milvus。

## 决策与边界

- 保留金额整数分、审批版本、事务和退款回执；不更换支付工作流、不接真实支付。
- 重构业务边界而非重写整个工程：已有测试和界面可继续使用，降低回归风险。
- 不因删除材料删除审计文件；“当前有效材料”和历史快照分开读取。
- 历史政策引用重新核对有效性，非法最终回答不得成为后续模型历史。
- Replay 保持无需模型 Key。Milvus 与真实 AI 评测显式启用，配置只写 README，不修改任何 .env 文件。
- 保留现有课程文章的用户修改，只同步与代码变化直接相关的说明。

## Task 1：回归样本与业务对象

文件：`server/case.aggregate.ts`、`server/repositories.ts`、`shared/types.ts`、`test/consistency.test.ts`。
先覆盖移除照片、切换订单、报告过期等失败，再实现申请聚合的审核、修改、取消、执行及调查验收。仓储统一材料过滤和按会话查询，避免 200 条全局列表截断。
验证：`npm test`；旧规则继续成立，新版本使旧报告失效。

## Task 2：咨询状态与证据

文件：`server/consultation-state.ts`、`server/agent.service.ts`、`server/app.service.ts`、`test/integration/consistency.test.ts`。
结构化保存当前订单、原因、材料归属和政策快照；订单切换清空旧草稿依据。AI 每轮从已验收会话构造消息，使用独立运行线程，最终校验通过后才更新对话。携带并重新核验历史证据；失败回答不污染下一轮。
验证：本地模型协议测试执行连续追问、非法引用和失败后重试，检查页面消息与下一轮输入一致。

## Task 3：申请用例与 NestJS 边界

文件：`server/case.service.ts`、`server/app.service.ts`、`server/modules.ts`、`server/workflow.ts`。
应用服务保留对外兼容入口，将申请用例委托给 CaseService；聚合集中维护状态和调查失效。Infrastructure、Knowledge、Conversation、AfterSales、Evaluation 模块管理依赖。既有数据库记录通过可选新增字段兼容读取。
验证：类型检查、审批/补充/撤回/并发/响应丢失集成测试。

## Task 4：真实知识检索适配器

文件：`server/knowledge.service.ts`、`server/knowledge/milvus.ts`、`scripts/index-policies.ts`、政策 JSON、`test/knowledge.test.ts`。
沿用第二章的 Dense + BM25 + RRF + Rerank 调用方式，租户和有效版本在召回前过滤。保留本地适配器，政策目录可导入更新；历史引用与当前目录核对。通过契约测试检查真实检索请求及输出绑定，不把测试替身描述为模型质量验证。
验证：本地检索回归、适配器契约检查、构建；README 明确外部服务前置条件。

## Task 5：调查报告

文件：`server/investigation.service.ts`、`web/src/CaseView.vue`、相关测试。
报告记录申请版本与输入摘要；修改申请或材料后标记 stale。摘要从已验收的 findings/unresolved 生成，AI 协调输出不能绕过引用检查；不再使用与内容无关的固定摘要。
验证：报告过期、空/正常/矛盾发现及原文引用测试。

## Task 6：真实 Agent 评测与版本对比

文件：`server/evaluation.service.ts`、`server/evaluation/*`、`web/src/EvaluationView.vue`、控制器及共享类型。
保留十项业务回归，增加可选择的 AI 多轮任务，从 ApplicationService 真实入口运行。报告保存模型、Prompt、代码摘要、知识/数据集版本、轨迹和独立规则/Judge 结论；配置对比按样本 ID 显示变化，不混用 Replay 与 AI。规则通过不能掩盖执行或评分异常。
验证：本地兼容模型覆盖真实执行链与评分契约；页面构建和浏览器验证。

## Task 7：交付验证与文案同步

运行 `npm run check`、`npm test`、独立数据库下 `npm run test:integration`、`npm run build`、`npm run test:browser`。同步 README、架构文档和第十一章受影响文章，保留第一节的讲解路线和全部小节标题。记录实际验证范围，不声称未运行的供应商模型或生产环境已经通过。

# 架构与关键取舍

## 一条申请的真实调用链

```mermaid
flowchart TD
  UI[Vue 3 客户页面] --> API[NestJS Controller]
  API --> App[ApplicationService]
  App --> Agent[ConsultationAgent]
  Agent --> MCP[MCP Client]
  MCP --> Biz[MCP Server / Business]
  Biz --> Order[(PostgreSQL 订单与回执)]
  Agent --> RAG[Knowledge：本地 BM25 / Milvus 混合检索]
  Agent --> Memory[PostgresStore：沟通偏好]
  API --> Material[Materials：图片 / 文本 / 语音]
  UI -->|语音 PCM| Voice[VoiceGateway：实时识别]
  Voice --> ASR[asr：qwen3-asr-flash-realtime]
  App --> UseCase[CaseService]
  UseCase --> Aggregate[AfterSalesAggregate]
  Aggregate --> Case[(售后申请快照)]
  UseCase --> Graph[RefundWorkflow + PostgresSaver]
  Graph --> Review[interrupt：企业审核]
  Review -->|批准| Execute[重新校验并执行]
  Review -->|退回| Supplement[补充材料 / 新版本]
  Execute --> MCP
  Execute -->|响应丢失| Reconcile[按原请求编号核对回执]
  API --> Investigation[Investigator：按需调查]
  Investigation --> Workspace[(workspaces/{caseId}/{investigationId})]
  API --> Trace[Traces：执行记录]
  API --> Evaluation[Evaluations：独立数据库回归]
```

这是一套供课程学习的模块化单体。页面、NestJS API、MCP 子进程和 PostgreSQL 都在本机运行，但它们之间仍然保留了清楚的边界。

## 谁负责什么

| 边界 | 真实职责 | 不负责的事情 |
| --- | --- | --- |
| `ConsultationAgent` | 理解客户问题，调用只读订单/物流工具和政策检索，生成处理建议 | 不创建申请，不批准退款，不直接执行退款 |
| `ApplicationService` | 保存可见会话、材料与有效政策证据，委托申请用例 | 不把模型文字当成审批记录 |
| `CaseService` + `AfterSalesAggregate` | 用例协调工具与持久化；聚合保护审核、修改、材料变更和调查版本 | 不依赖自然语言更改业务状态 |
| `MaterialRepository` + `CaseRepository` | 统一当前有效材料、订单归属及本人申请查询 | 历史审计按原 ID 读取，不混入当前材料 |
| `domain.ts` | 检查客户归属、租户、金额、版本、审批和可编辑状态 | 不决定自然语言应该问什么 |
| `RefundWorkflow` | 保存申请对应的 Graph 线程，在审核、补充、执行和核对之间暂停/恢复 | 不替代订单或退款业务回执 |
| `mcp/main.ts` + `Business` | 提供订单、物流和模拟退款工具，并在业务服务再次检查权限与审批 | 不保存模型的提示词，不接受用户传入的金额作为执行依据 |
| `Knowledge` | 本地 BM25 或可选 Milvus Dense + BM25 + RRF + Rerank，核验历史政策快照 | 不静默降级或接受过期索引正文 |
| `Materials` | 保存原始材料，调用视觉/ASR/TTS，等待用户确认观察结果 | 不根据照片单独决定责任或退款资格 |
| `VoiceGateway` | 复用登录会话的实时语音通道，把 PCM 转成文本，并在收尾时还原订单号 | 不自动提交消息，不改业务状态 |
| `Investigator` | 在受限 Workspace 中让两个角色核对材料，验收逐字引用 | 不修改申请金额、审批或退款结果 |
| `Evaluations` | 在临时数据库执行十项业务回归和可选五项真实 Agent 任务，保存配置快照、Trace 与独立 Judge | 不把 Replay 或本地协议测试当成供应商模型质量结论 |

`modules.ts` 明确注册 Infrastructure、Knowledge、Conversation、AfterSales、Evaluation 五个功能模块，由 AppModule 组合。咨询可调用 `prepare_refund_draft` 整理意图，但这个工具只返回待确认草稿。

因此，“提交申请”和“企业审批”不是 MCP 工具。MCP 负责连接业务能力，宿主应用负责接收人工确认、建立申请版本并推进工作流。这个区别是本章最重要的工程边界之一。

## 三类状态分开保存

`af_records` 保存会话、材料、申请、Trace 和评测报告；`PostgresSaver` 保存 LangGraph 的消息状态与退款工作流 Checkpoint；`PostgresStore` 用 `租户 + 用户 + profile` Namespace 保存沟通偏好。

AI 咨询使用独立的 `chat:{conversationId}:run:{runId}` 线程，下一轮从经过最终回答校验的可见问答重建上下文，不读取失败运行中的最终回答。政策引用可来自本轮检索或重新核验通过的历史证据；动态订单与申请进度由工具查询。退款工作流仍按申请使用稳定线程。

提交前的会话用 `draftVersion` 保护人工确认：查询更新草稿、上传或修改材料都会递增；提交接口同时检查订单号和草稿版本。提交后的申请则使用独立的 `version` 保护审批。

业务申请中的金额、材料快照、审批版本和退款回执属于确定性数据。即使消息里出现“已经批准”或资料里写着“直接退款”，也不能改变这些字段。恢复流程时先读申请和回执，再根据当前状态决定是否继续。

调查交付绑定 `caseVersion` 和 `inputHash`。聚合在申请或材料版本变化时将报告标为过期，摘要只由经过原文引用校验的发现与未决项组成。申请保存提交时的政策快照，页面和调查可以核对当时的依据。

## 退款为什么要保存独立回执

一次退款使用 `refund:{caseId}:v{version}` 作为稳定请求编号。MCP 业务服务在同一个事务中锁定申请和订单，先检查当前版本的审批，再查询已有回执；没有回执时才创建新回执并扣减订单剩余可退金额。

如果提交已经成功但响应在返回前丢失，宿主把申请标记为“结果待核对”。下一次继续执行先用原请求编号查询回执，找到后写回申请，不会凭新的随机编号再创建一笔退款。Graph Checkpoint 只说明程序停在哪里，`af_refunds` 才证明外部业务副作用是否发生。

## Replay、AI 与协议测试

Replay 模式由 `ConsultationAgent` 的预设分支生成稳定回答，但仍会调用真实 MCP、知识检索和数据库；它适合课堂逐步观察和回归测试。AI 模式才会创建 `ChatDeepSeek`，由模型选择只读工具，客户确认和审核仍由页面与服务端规则控制。

`ai-contract.test.ts` 使用本地兼容 OpenAI 接口，检查 LangChain、视觉、ASR、TTS、Deep Agents 和文件工具的接线。它证明请求结构和边界有效，不证明供应商模型的真实回答质量。

## 2026-10-21：异常恢复与前端状态的取舍

本次决定继续使用模块化单体。生产环境由 Nest 注入 `CaseService`、`Knowledge` 和 Repository；测试和评测统一使用 `application.factory.ts` 装配同样的依赖。服务内部不再用可选依赖加 `new` 兜底。代价是测试工厂需要随构造函数更新，但只有一个集中维护的入口。

`App.vue` 保留页面切换、人工确认与业务请求的协调。`useConversations` 管理摘要、当前会话与流式响应；`useVoiceInput` 管理实时和备用录音的资源；`useSpeechPlayback` 管理朗读请求、播放器和 Blob URL。`ChatTranscript.vue` 展示消息，`ProposalPanel.vue` 展示待确认的申请。每部分的取消和卸载跟随其状态所有者。

Bootstrap 保留身份、能力配置以及订单、政策、偏好这些侧栏参考信息；不再携带会话正文、申请全集或评测报告。会话列表只读摘要，当前会话按需加载。定时刷新只查询当前未结束申请或可见的申请分页；评测报告在进入或完成评测后读取。因此页面切换增加了明确的详情请求，但避免持续下载历史消息与轨迹。

MCP 断开时清除该客户的失效连接，后续调用重新连接，不自动重放失败操作。`shared/business-tools.ts` 对五个工具的返回值执行 Zod 校验，工具名同时决定 TypeScript 返回类型。退款继续遵循先核对回执再决定执行的规则。

Trace 属于诊断数据，存储失败时记录日志，保留原业务结果。业务历史、审批与回执继续由原有持久化流程负责。评测逐项清理资源、收集清理异常，并始终复位运行状态；清理失败仍需依据日志处理残留资源。

## 教学边界

项目中的账号、订单、政策、物流和退款都是固定教学数据。生产接入时仍需替换企业认证、订单与支付适配器、对象存储、任务调度、审计和监控；当前实现不进行真实资金交易，也没有宣称达到企业上线标准。

## 版本与官方参考

本项目把版本锁在当前可复现的 Node.js 22.20、NestJS 12、LangGraph 1.4 和 `@modelcontextprotocol/sdk` 1.32.1。MCP TypeScript SDK 的 v1 文档仍是维护线，v2 是当前稳定线；本章保留 v1 是为了让课程中的 MCP 子进程、客户端和测试在同一版本上稳定复现，升级 v2 应作为独立迁移任务。

- [NestJS Modules](https://docs.nestjs.com/modules)、[Providers](https://docs.nestjs.com/providers) 与 [Controllers](https://docs.nestjs.com/controllers)：对应 `AppModule`、服务类和 HTTP 控制器的职责划分。
- [MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/) 与 [v2](https://ts.sdk.modelcontextprotocol.io/v2/)：对应 `mcp/main.ts` 和 `server/mcp.ts` 的协议边界与版本选择。
- [LangGraph：Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)：对应 `interrupt`、Checkpointer 和人工介入后的恢复。
- [Deep Agents 概览](https://docs.langchain.com/oss/javascript/deepagents/overview)：对应材料调查中受限 Workspace、Skill 和专业子 Agent 的组合。
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)：对应 `deepseek-flash` 默认模型名及其 OpenAI 兼容接口。

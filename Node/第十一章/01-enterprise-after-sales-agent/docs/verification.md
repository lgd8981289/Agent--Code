# 验证记录

## 2026-10-21 代码质量调整

在 Node.js 22.20.0 下完成本轮验证。保留原有金额、归属、审批版本与退款幂等规则；新增连接恢复、资源清理和前端状态管理的检查。

| 检查 | 本轮结果 |
| --- | --- |
| `npm run verify` | 服务端、Vue、测试代码类型检查，ESLint、Prettier、41 项单元测试和 17 项集成测试通过 |
| `npm run test:browser` | 构建与隔离浏览器回归通过，包含会话改名/删除、材料、审批、失效登录、移动端和评测报告 |
| MCP 断线恢复 | 关闭已经连接的真实 MCP Client 后，再次查询成功，越权订单仍被拒绝 |
| Trace / 评测清理故障 | 注入持久化与清理异常，业务结果/原异常保留，下一轮评测仍能启动 |
| 录音生命周期 | 单元测试检查停止、取消和迟到媒体授权；浏览器媒体替身检查按钮、音轨释放、取消后不覆盖草稿 |
| 会话请求乱序 | 迟到详情不能覆盖新选择；换账户后迟到列表/详情不能恢复旧用户数据 |
| 朗读与页面刷新 | 浏览器使用有效 WAV 替身，原生播放器时长为 1 秒且播放时间推进；取消合成后不创建播放器；空闲聊天跨过两个轮询周期不重新下载 Bootstrap/会话列表 |

前端将会话请求、语音输入、朗读分别放入 composable，消息展示与申请表单分别放入 `ChatTranscript.vue`、`ProposalPanel.vue`。会话列表只返回摘要，当前详情按需读取。回归过程中补齐了改名后同步聊天标题、筛选后创建申请时切回新申请这两处联动。

截图位于 `test-artifacts/quality-chat.png` 与 `test-artifacts/usability-*.png`。本轮常规回归没有调用真实 DeepSeek 或百炼；真实供应商结果仍以之前明确标注的 live 验证为准。新增测试使用独立数据库，保留现有演示数据，未修改环境配置。

## 2026-10-21 咨询引用、流式回复与朗读修复

从本机失败 Trace 确认：模型通过 `get_my_cases` 读取了已有申请的有效 `policySnapshots`，但原实现没有把这批政策加入 `evidence`，最终将 `POL-DAMAGE-V3` 误报为未经核验。修复后，申请快照先核对当前目录，再登记本轮证据；无效或正文不一致的快照仍被排除。

Node.js 22.20.0 下完成以下验证：

| 检查 | 结果 |
| --- | --- |
| `npm run check`、`npm run build` | 类型检查与前后端构建通过 |
| `npm test` | 32 项通过；新增跨包中文 SSE、分段引用、流中断、WAV 长度修正与音频下载错误测试 |
| `npm run test:integration` | 16 项通过；本地模型替身重现新会话读取申请快照，验证真实模型流协议、非法引用和取消后失败记录 |
| `npm run test:browser` | 隔离数据库中的既有 Replay 业务和界面流程通过；页面使用新的 SSE 入口 |
| `node scripts/browser-ai-audio.mjs --live` | 独立数据库、端口和 Chrome 中调用真实 DeepSeek 与百炼，用户原句成功；原有申请未修改 |

本次真实 AI 样本在约 2365ms 出现第一段文字，约 4238ms 完成并保存为 `accepted`，三份政策来源齐全。这是单次观察，不是稳定延迟承诺。流式增量在模型生成过程中按段落发布；没有段落分隔的短回答在末尾一次显示。

真实 TTS 返回了使用长度占位值的 WAV。下载并修正封装后，Chrome 的播放器读到有限时长 132.56 秒，`readyState=4`、`paused=false`、`muted=false`、`volume=1`，播放时间推进超过 0.2 秒。这证明浏览器解码与播放链路工作，没有以自动化测试声称已人工听到扬声器输出。脚本随后复用该音频，主动模拟自动播放被拦截和下载失败，验证手动播放、停止、错误提示，以及取消后迟到响应不开始播放。

截图在 `test-artifacts/consultation-live-stream.png` 和 `test-artifacts/consultation-live-audio.png`。真实供应商验证脚本要求显式传入 `--live`，会产生模型调用费用；运行前先 `npm run build`。常规单元、集成和浏览器回归不调用收费模型。

实现核对参考：[LangChain 流式返回](https://docs.langchain.com/oss/javascript/langchain/streaming)、[百炼 Qwen-TTS API](https://help.aliyun.com/zh/model-studio/qwen-tts-api)。

## 2026-10-21 课程备课核对

核对范围：第 02 节压缩后的主调用链，以及第 03～09 节的材料、语音、记忆、审批、退款、调查和评测描述。对照当前源码与测试修正了讲义；以下结果不替代真实供应商模型和浏览器兼容性验证。

本次在 Node.js 22.20.0 下执行，使用 `DOTENV_CONFIG_PATH=/dev/null` 隔离本地模型配置：

| 检查 | 结果与范围 |
| --- | --- |
| `npm test` | 27 项通过，覆盖领域规则、材料与历史一致性、检索适配器、调查引用和订单号格式修正 |
| `npm run test:integration` | 16 项通过，使用真实 PostgreSQL、MCP 子进程、LangGraph，以及本地模型测试替身 |
| 两种退款故障专项运行 | 使用 `isolatedSystem()` 分别运行 `before_submit` 和 `timeout_after_commit`，再通过人工继续接口核对 |
| 后备录音停止函数模拟 | 发现缺口，见下文；没有使用真实麦克风或供应商服务 |

两种退款故障的实际结果：

- 提交前故障：首次 `unknown`，回执数 0、已退金额 0；继续后 `completed`，执行次数 2、回执数 1、已退金额 350000 分。
- 响应丢失：首次 `unknown`，但回执数已经为 1、已退金额已经为 350000 分；继续后 `completed`，执行次数 2，回执和已退金额均未重复增加。

讲义修正的主要事实：

- 03：区分提示词要求与可执行校验；语音权限、配置状态和后备路径按实际代码描述。图片协议测试没有单独断言 `image_url` 载荷。
- 04：Replay 的进度查询走 `ownCases()`；读取申请中的回执快照，不等于实时查询退款表。自动记忆和手动保存采用不同筛选范围。
- 05：客户提交后创建待审申请，企业批准后同步继续 Graph；正常返回可能已经是 `completed`。
- 06：退款增加 `refundedCents`；已有回执走一致性核验，不再要求仍有同额剩余可退金额。五次预算位于人工继续接口。
- 07：调查读取图片观察说明、文本和固定演示资料；逐字引用校验不能证明结论正确。
- 08：隔离数据库按批次创建，样本间按需重置数据；Trace 不是所有内部调用的完整审计，Judge 评阅每项 AI 任务的最后一轮。
- 09：语音转写回到输入框，确认发送后保存为消息，原始音频没有作为材料持久保存。

当时发现的代码限制（已在上方代码质量调整中修复）：`web/src/App.vue` 的 `recordByUpload()` 创建了局部 `MediaRecorder`，`finishVoice()` 没有访问这个实例。函数模拟调用后，界面 `recording` 已为 `false`，录音器仍为 `recording`，音轨未停止，自动停止定时器也已被清除。后备录音的手动停止和取消必须接入同一个录音实例，并补充浏览器验证；现有集成测试通过不覆盖这一缺口。第 03 节已标注此限制。

本次没有调用真实 DeepSeek、百炼或 Milvus 服务，也没有重跑浏览器 smoke。下方保留的是此前验证记录，不能合并为本次实测结果。

## 2026-10-20 历史验证

验证日期：2026-10-20。验证环境：macOS、Node.js 22.20.0、Docker Desktop、PostgreSQL 17、系统 Chrome。

### 执行过的检查

在项目目录执行：

```bash
npm run check
npm test
npm run test:integration
npm run build
PLAYWRIGHT_CHANNEL=chrome npm run test:browser
```

本地执行环境的 `npm` 入口曾指向 Node.js 16；项目现在会先运行 `scripts/assert-node.mjs`，在导入 LangChain 或 Vite 前明确提示版本不足。上面命令应在 Node.js 22.20 或更高版本下运行。

Node.js 22 下，类型检查、8 项领域单元测试、3 组集成测试（14 个测试用例）、服务端编译和前端构建通过。集成测试使用真实 PostgreSQL、真实 MCP 子进程和 LangGraph，不调用收费模型。

浏览器验证分两段运行：

```bash
PLAYWRIGHT_CHANNEL=chrome node scripts/browser-smoke.mjs pending
# 可以在这里停止并重新启动服务
PLAYWRIGHT_CHANNEL=chrome node scripts/browser-smoke.mjs continue
```

第一段完成 Replay 咨询、演示照片、材料确认和提交；第二段验证重启后的审核、响应丢失、回执核对、材料调查、回归报告、跨会话偏好和 390px 页面。截图保存在 `test-artifacts/`，属于本地验收产物。

### 每项检查证明什么

- `npm test`：证明身份、租户、金额、审批版本、稳定请求编号、回执核对、政策过滤和调查引用规则。
- `test/integration/flow.test.ts`：证明 Replay、真实 MCP、PostgreSQL、LangGraph 和版本回归可以串起来。
- `test/integration/ai-contract.test.ts`：证明模型、视觉、ASR、TTS、Judge、Deep Agents 文件工具的协议接线，不评价真实模型效果。
- `test/integration/usability.test.ts`：证明材料去重、撤回、补充、并发、分页、会话删除和失败恢复等边界。
- 浏览器 smoke：证明用户可以沿页面走完主线，并看到状态与产物变化。

这些结果只覆盖课程样本和本地模拟业务。通过 Replay 或协议测试不能推出真实供应商模型对所有提示注入、图片和语音输入都可靠。

### 官方参考

- [NestJS Modules](https://docs.nestjs.com/modules)、[Providers](https://docs.nestjs.com/providers)、[Controllers](https://docs.nestjs.com/controllers)
- [MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/) 与 [v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [LangGraph：Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
- [Deep Agents 概览](https://docs.langchain.com/oss/javascript/deepagents/overview)
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)

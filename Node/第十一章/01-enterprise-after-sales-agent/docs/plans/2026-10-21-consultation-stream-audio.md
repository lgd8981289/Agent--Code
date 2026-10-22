# 咨询引用、流式回复与朗读修复 Implementation Plan

**Goal:** 修复已有申请政策快照被误拒绝、朗读无反馈，并让咨询回答真正流式返回。

**Architecture:** 查询申请时重新核验政策快照并登记本轮证据。LangChain 的 messages/values 流经引用检查和 SSE 到达 Vue，最终成功或失败记录仍由 ApplicationService 保存。TTS 经服务端限时下载和 WAV 封装修正，前端提供加载、停止、手动播放与错误状态。

**Tech Stack:** NestJS 12、LangChain 1.5.12、Vue 3、PostgreSQL、node:test、Playwright。

## 1. 政策引用

- 修改 `server/agent.service.ts` 中 `ownCases()`：使用 Knowledge.revalidate 校验同租户、有效版本和正文摘要，将通过的快照加入 evidence；无效快照不作为当前政策返回。
- 在 `test/integration/ai-contract.test.ts` 补充已有申请、新会话只查询进度就引用政策的回归；覆盖过期或篡改快照不被放行。
- 保留最终回答引用校验，不按 ID 存在就直接放行。

## 2. 流式咨询

- 在 `shared/types.ts` 定义事件；新增 `server/answer-stream.ts` 缓冲段落并校验引用。
- 修改 `server/agent.service.ts` 支持 messages/values；新增 POST messages/stream，原 JSON 接口保留。
- 修改 `server/app.service.ts` 传递取消信号，仍只保存最终结果。
- 修改 `web/src/api.ts` 解析 SSE，`App.vue` 显示实时进度和草稿；失败用最终错误记录替换草稿，连接异常刷新已保存状态。
- 验证真实 token、跨包中文/引用、工具切换、空回答、非法引用、断连与重复发送。

## 3. 朗读

- 修改 `server/materials.service.ts` 下载供应商返回的受限 OSS 音频，限制大小、时限与重定向，修正 WAV 长度。
- 修改 Controller 返回 audio/wav 字节；Vue 使用 Blob URL 与原生播放器，捕获合成、下载、解码和自动播放失败，停止时取消请求并释放资源。
- 验证音频字节、非音频响应、超时、停止后迟到结果和实际浏览器播放进度。

## 4. 交付验证

- Node.js 22.20 下运行 `npm run check`、`npm test`、`npm run test:integration`、`npm run test:browser`。
- 隔离数据库验证真实 AI 和 TTS，不修改现有申请，不改 `.env` 文件。
- 同步 README 与课程第 02、03、04 节受影响的调用链描述，记录协议测试与真实供应商验证的区别。

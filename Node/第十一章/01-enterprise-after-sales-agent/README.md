# 企业售后处理 Agent

第十一章综合项目。围绕一笔售后申请，组合订单工具、政策检索、图片与语音、短期与长期记忆、持久化人工审核、受控执行、复杂材料调查与回归评测。

后端使用 NestJS，前端使用 Vue 3。默认 Replay 演示无需模型密钥，仍然调用真实 MCP 服务并写入 PostgreSQL；AI 模式使用 LangChain Agent 调用 DeepSeek。订单、物流、退款属于独立的教学模拟业务，不发生真实资金交易。项目脚本会在导入 LangChain 前检查 Node.js 版本，低于 22.20 时会直接给出切换提示。

## 启动

需要 Node.js 22.20+、Docker Desktop。所有命令在本目录执行：

```bash
npm install
npm run db:up
npm run setup
npm run doctor
npm run dev
```

- 页面：<http://127.0.0.1:5190>
- API：<http://127.0.0.1:4320/api/health>
- PostgreSQL：本机 `5441` 端口。连接字符串见 `server/config.ts` 与 `docker-compose.yml`。
- 前端会等待正确的 API 启动，数据库未启动时先修复服务端日志中的错误。
- 页面右上角切换演示账号。客户、另一客户、企业审核人员和另一企业分别由服务端固定映射；模型与请求正文不能自定义角色或租户。

启动时会准备演示订单，已有业务记录不会被覆盖。数据库保存在 Docker Volume，`npm run db:down` 只停止容器，不删除记录。照片与工作文件分别保存在 `data/materials` 与 `workspaces`。

需要从头重复录制退款演示时，先停止开发服务，再运行 `npm run reset-demo -- --yes`。这会明确删除本项目的演示记录、材料和记忆，并重新准备订单；不要对需要保留的演示数据执行该命令。

## 配置真实模型

Replay 演示不需要密钥。需要 AI 对话、图片理解、语音识别或朗读时，自行在本目录创建 `.env`：

```dotenv
DASHSCOPE_API_KEY=你的百炼 Key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen3-vl-plus

DEEPSEEK_API_KEY=你的 DeepSeek Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

项目不生成、不修改、也不附带任何 `.env` 文件。一个 Key 都不填同样能跑完全部流程：Replay 不调用模型，但依然启动真实 MCP 子进程、写真实 PostgreSQL。

多模态这一组里只给图片理解留了 `VISION_MODEL`。语音的两个模型名写死在 `server/voice/asr.ts` 与 `server/materials.service.ts` 里，和第九章的语音示例一致，不需要配置。

百炼的三种能力共用一个 Key 和一个域名，只差路径：图片与录音走 `/compatible-mode/v1`，朗读走 `/api/v1`，实时识别走 `/api-ws/v1`。所以不需要为语音合成单独配地址。使用独立业务空间时，只改 `DASHSCOPE_BASE_URL` 这一处，填控制台给出的完整地址：

```dotenv
DASHSCOPE_BASE_URL=https://你的业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

Key、地址和地域要配套，别把北京地域的 Key 配到新加坡地址上。改完 `.env` 必须重启 `npm run dev`；会话模式在新建时确定，旧会话保留原模式。`npm run doctor` 会检查端口、数据库连接、百炼地址和演示照片，并显示当前视觉模型，不打印密钥。

`VISION_MODEL` 显式配置优先于代码默认值，不会因失败自动换成其他模型。若沿用前面课程的 `qwen3-vl-flash`，请确认当前接口仍支持它；`404 model_not_found` 表示这次模型请求无法完成，不是本地演示照片丢失。可以运行 `npm run doctor -- --models`，使用当前 Key 和地址查询模型目录；该命令不发送照片、不生成回答。目录检查通过仍需实际图片请求验证。更换为 `qwen3-vl-plus` 等模型前，应先确认目标模型在当前账号和地域下可用，不能把一次接口报错解释为某模型已全面下线。

`POSTGRES_URI`、`PORT`、`WEB_PORT` 都有默认值（分别在 `server/config.ts` 与 `docker-compose.yml`），需要临时改动时用环境变量覆盖，不必写进 `.env`：

```bash
PORT=4330 WEB_PORT=5200 npm run dev
```

AI 对话、图片、ASR、TTS、AI 调查和回答评阅均会产生供应商费用。未配置对应服务时，其入口不可用。Replay 的预设观察只支持内置照片，不能用于任意图片。语音输入边说边出字，最终文本进入输入框由用户核对后再发送；识别通道复用同一个登录会话，未登录的连接会被直接拒绝。停止朗读只停止播放。

语音有两条路径：支持 `AudioWorklet` 的浏览器（Chrome / Edge）走 `/api/voice` 的 WebSocket 实时识别；无法以 16kHz 采集的环境自动退回 `POST /api/voice/transcribe` 整段上传。两条路径的最终文本都只是草稿，权限、金额与审批仍由服务端规则决定。

朗读时先显示生成状态；服务端下载百炼音频，修正 WAV 文件头中的长度占位值，再通过本地接口返回音频字节。页面提供可暂停、重播的播放器；自动播放受浏览器限制时，可手动点击播放。生成期间可以取消，失败会显示原因。`POST /api/voice/speak` 现在返回 `audio/wav`，不再返回音频 URL JSON。

聊天使用 `POST /api/conversations/:id/messages/stream` 返回 SSE。AI 的实际模型增量按段落核对引用后显示，结束时保存最终回答；短回答没有段落分隔时在末尾一次显示。临时段落不是成功记录，失败会替换为错误提示，页面断开会取消本轮生成。Replay 只显示处理进度和最终预设回答。原 `/messages` JSON 接口仍供评测等调用。

## 可选：沿用第二章的 Milvus 混合检索

默认 `KNOWLEDGE_BACKEND=local`，AI 与 Replay 都可使用本地 BM25。政策原文统一位于 `knowledge/policies.json`，保留有效版本与历史版本；应用启动时校验并加载这个目录。

要复用第二章的 Milvus 服务，先配置以下环境变量，再执行 `npm run knowledge:index`。这些只是配置示例，脚本不会创建或改写 `.env`：

```dotenv
KNOWLEDGE_BACKEND=milvus
MILVUS_ADDRESS=127.0.0.1:19530
AFTERSALES_POLICY_COLLECTION=aftersales_policies_v1
ZHIPU_API_KEY=你的智谱 Key
EMBEDDING_MODEL=embedding-3
EMBEDDING_DIMENSIONS=512
RERANK_MODEL=rerank
```

可选 `MILVUS_TOKEN` 用于需要认证的 Milvus，`ZHIPU_BASE_URL` 默认 `https://open.bigmodel.cn/api/paas/v4`。索引脚本使用单独的售后 Collection，不覆盖第二章知识库。Milvus 服务需要支持 BM25 Function 和中文 jieba 分词；可使用第二章同一套环境。

AI 检索按 `Dense + BM25 → RRF → Rerank` 执行。租户、有效状态和分类会同时写入两路召回的过滤条件；返回后再与当前目录的版本和内容摘要核对。索引落后时不会接受旧正文，服务不可用时返回错误。Replay 始终使用本地检索，便于离线课堂演示。

修改政策后，重新运行 `npm run knowledge:index` 并重启应用。修改向量维度时使用新的 Collection 名称，避免复用旧维度。单元测试检查适配器协议和过期索引过滤；真实 Milvus、Embedding 与 Rerank 效果需要在该环境中另行运行验证。

## 演示一：从咨询到待审核

1. 使用「林晓 · 客户」，保持「Replay 演示」。点击开场的「咖啡机到货损坏，申请退款」，或发送：`A1024 咖啡机刚收到，外壳裂了，实付 3500 元，我想申请退款。`
2. 核对回答与右侧订单、三份政策。右侧来源可展开查看正文，切到「轨迹」可查看实际 MCP 与检索结果。
3. 点击输入区的「添加演示照片」，右侧进入材料区，查看原图及预设观察，点击「确认这份材料」。图片为 AI 生成的虚构教学照片。
4. 回到「处理建议」，核对金额与说明，勾选确认，点击「确认申请，提交企业审核」。提交会携带订单号与 `draftVersion`；其他页面改过订单或材料时，旧确认会被拒绝，需要刷新重新核对。
5. 页面进入申请详情，此时状态为「等待审核」，还没有退款记录。申请、材料、政策与执行轨迹都可以查看。

演示订单的签收时间在首次初始化时设为前一天，演示到货损坏政策为签收后 7 天。长期保留的旧订单超过窗口后会提示人工核对，不会悄悄刷新签收时间或覆盖已有订单。

## 演示二：审核、重启与结果核对

1. 提交申请以后，可以停止 `npm run dev` 再重新启动，刷新页面核对申请仍在等待审核。
2. 切换到「周宁 · 售后审核」，打开该申请。在详情底部输入意见，分别尝试「批准并执行」「退回补充」或「拒绝申请」。
3. 批准后调用 MCP 模拟退款服务；完成以后显示业务编号、金额与稳定请求编号。右上下载按钮可下载申请与执行记录 JSON。
4. 退回补充后切回客户，在「我的申请」修改说明并重新确认。需要补充文件时，返回对应服务会话上传和确认材料，再重新确认申请。版本递增，旧版本审批会被拒绝。
5. 申请进入执行或终态以后，禁止客户修改金额与材料。

所有模拟退款都需要客户确认与企业批准当前版本。真实的审批记录与金额校验同时存在于应用和 MCP 业务服务中，资料正文不能代替它们。

### 日常操作补充

- 「我的申请 / 审核工作台」可以按申请号、订单、商品或问题搜索，按状态筛选、按提交或更新时间排序，并翻页查找全部申请。
- 客户可在「等待审核 / 补充材料」阶段填写原因撤回申请。撤回后工作流停止，原记录保留，需要重新申请时新建会话。
- 材料可查看原文件、移除误传内容。同一订单的相同文件不会重复添加，每个会话最多 10 份有效材料。材料会绑定订单，切换订单时不会把旧订单照片用于新申请。已提交申请修改材料后版本递增，需要客户重新确认送审；历史文件及说明快照保留供核对。
- 退回补充、拒绝必须填写具体理由。审批确认弹窗会展示申请、金额和版本，批准后仍由服务端校验当前状态。
- 「处理记录」保存操作者、时间及当时确认的内容。新功能上线前产生的记录按已有审批信息显示，不补造旧版快照。
- 会话列表支持名称搜索、逐条重命名和删除。删除前展示会话名称及影响范围，处理中禁止重复提交；失败后确认框内可查看原因并重试。
- 会话删除采用软删除，从列表移除入口，保留消息与业务依据。不会撤回或删除售后申请；需要补充材料时，从申请详情返回原会话会重新显示该会话。删除当前会话后切换到另一条，删除最后一条后显示新对话空状态。
- 重命名、删除、材料确认与偏好保存会显示结果提示。删除沟通偏好需要再次确认，不会连带删除聊天记录。消息可复制，中文输入法组合输入时回车不会发送，Shift+Enter 换行。
- 服务连接中断、登录过期会显示明确提示。切换账号会清空未发送草稿和旧资料，正在处理时限制切换。

### 响应丢失实验

第一次提交前，在右侧「故障演示设置」选择「已受理，但响应丢失」。这是程序主动注入的故障。

批准以后，页面显示「结果待核对」。业务服务已经保存退款，但宿主没有收到成功响应。点击「核对结果并继续」，系统用原请求编号查询回执，再写回完成状态，不创建第二笔退款。

「提交前服务暂不可用」则在提交以前失败。手动继续时解除该演示故障并再次执行，仍然复用同一请求编号。单份申请最多允许五次执行尝试。

## 演示三：会话恢复与长期记忆

可见会话与政策快照保存在 `af_records`。AI 每轮只带入最近十组成功问答，重新核对历史政策；查询已有申请时，也会核验其中的政策快照并登记到本轮证据，避免把模型实际读到的有效政策误报为未知来源。本轮执行用 `chat:{conversationId}:run:{runId}` 保存独立 Checkpoint。最终回答的非空和引用检查通过后才标为 accepted；失败提示保留在页面中，但失败问答不会进入后续模型历史。这个检查不保证回答语义完全正确，语义质量另由评测核对。

- 在左下角「沟通偏好」保存「优先使用文字沟通」，新建会话后仍可读到同一用户的偏好。
- 发送「帮我查一下上次售后申请的处理进度」。Agent 查询最新业务记录；多个对象不明确时需要澄清。
- 偏好可修改，或选择「删除偏好并停止自动记忆」。删除正文以后保留阻断标记，明确再次保存时重新启用。
- 演示中的自动提取仅识别明确的长期沟通偏好表达，不会保存退款权限、审批指令或原始照片。申请状态和金额始终从业务记录查询。
- 切换到另一客户或另一企业，不能读取前一用户的会话、材料和记忆。

## 演示四：复杂材料调查

打开申请的「材料调查」页，选择 Replay 或 AI，点击「开始材料调查」。普通订单咨询不会运行这套协作。

该实验明确加入 `server/fixtures.ts` 中的两份演示资料：历史客服沟通与检测说明，再加入申请已有材料。Replay 写入预设、可逐字核对的调查结果；AI 模式由协调 Agent 调用事实与政策两个专业角色，角色使用 Deep Agents 文件工具及 Skill 读取资料并交付 JSON。

文件保存在 `workspaces/{caseId}/{investigationId}`，包含 `inputs/`、`skills/`、`staging/` 和正式 `report.json`。应用验证引用存在于输入原文，核对失败时不会接受交付。调查报告记录 `caseVersion` 和输入摘要 `inputHash`，摘要由验收通过的发现与未决问题生成。修改申请或材料会把旧报告标为 `stale`，页面提示重新调查；旧文件保留供核对。报告只供人工参考，不修改申请金额或审批结果。

## 演示五：质量验证与版本对比

切换企业审核账号，进入「质量验证」。分别运行：

- `v1 · 金额展示故障`：隔离评测中主动将回答里的实付金额缩小 100 倍。
- `v2 · 当前实现`：保持正确单位。

两版执行同一组 10 项测试，包括实际咨询、缺少材料、MCP 越权、审批权限、旧版本、退回补充、拒绝、响应丢失与重复请求、记忆限制、调查引用。每批创建独立数据库，结束后删除；不会清理页面里的真实演示申请。需要数据库账号具备创建测试数据库的权限，本项目 Docker 账号已具备。

配置 DeepSeek 后，可把「执行方式」切为 AI。应用先执行同样的十项业务回归，再通过 `ApplicationService.send()` 运行五项真实 Agent 任务：金额查询、连续政策追问、更换订单、跨用户查询、绕过审批。每个 AI 样本从新会话开始，规则检查和独立 Judge 分别记录；规则失败、Agent 异常或 Judge 异常都不能得到发布通过。页面允许覆盖咨询模型和提示词；固定身份、证据与审批规则始终保留。此模式会调用已配置的供应商并产生费用。

报告保存模型、提示词、代码摘要、政策摘要、数据集版本，以及 AI 问答和 Trace，下载后可以复核实际配置。选择「对比报告」按样本 ID 查看改善或退步；不同执行方式或数据集不能混算。Replay 的金额故障基线仍然只用于演示单位错误，不能冒充真实模型版本。

客户会话底部的「评阅本次回答」仍可单独运行。Judge 核对真实工具结果、当前回答及有效政策，并返回回答中的逐字引用；程序校验引用存在，但评分质量仍需人工抽查。

## 验证命令

```bash
npm run verify
npm run test:browser
# 修改格式后可执行
npm run format
```

`verify` 包含服务端、Vue 和测试代码类型检查，ESLint、Prettier，以及单元和集成测试。`test:browser` 会先构建，再运行隔离浏览器回归。单元测试不需要数据库。集成测试需要 PostgreSQL，使用真实 MCP 子进程与独立数据库，不调用收费模型。浏览器截图脚本位于 `scripts/browser-smoke.mjs`，需先运行开发服务与安装 Playwright 浏览器。

AI 协议集成测试使用本地兼容响应，实际经过 LangChain、Deep Agents、文件工具、MCP 和存储，验证工具回传、连续政策追问、非法回答隔离、五项 AI 任务及 Judge 报告，同时检查候选文件与引用验收、视觉、ASR、TTS 的请求结构。这种测试验证接线，不评价供应商模型的真实效果。

新增的 `npm run test:browser` 会构建项目，以独立数据库和临时端口验证日常使用功能，默认使用本机 Chrome，不更改当前页面中的申请。完整的功能检查、验证范围与企业上线待接入项见 [企业使用完整性检查](docs/enterprise-readiness.md)。

需要验证真实 AI 流式回答和朗读时，先 `npm run build`，再执行 `node scripts/browser-ai-audio.mjs --live`。脚本使用独立数据库和端口，准备一笔待审申请，再发送本文开场问题；同时检查音频解码、播放进度、自动播放受限后的手动播放、取消及失败提示。此脚本需要已配置的 DeepSeek 和百炼，会产生调用费用，不属于常规离线回归。详细结果见 [验证记录](docs/verification.md)。

浏览器首次验证可运行 `npx playwright install chromium --only-shell` 后执行 `node scripts/browser-smoke.mjs all`。macOS 已安装 Chrome 时，也可以设置 `PLAYWRIGHT_CHANNEL=chrome` 执行。脚本截图保存到 `test-artifacts/`；从头执行前应使用尚未处理的演示订单。验证真实重启时，先执行脚本的 `pending` 阶段，再停止并重启服务，最后执行 `continue` 阶段。

## 代码与课程入口

| 小节 | 主要代码 |
| --- | --- |
| 01 项目运行与分工 | `README.md`、`server/main.ts`、`web/src/App.vue` |
| 02 Agent + MCP + RAG | `server/agent.service.ts`、`server/mcp.ts`、`mcp/main.ts`、`server/knowledge.service.ts` |
| 03 图片与语音 | `server/materials.service.ts`、`server/voice/`、`web/src/recorder.ts`、`web/src/composables/useVoiceInput.ts`、`web/src/composables/useSpeechPlayback.ts` |
| 04 会话与长期记忆 | `server/app.service.ts`、`server/memory.service.ts`、`server/storage.ts` |
| 05 确认与审批 | `server/case.service.ts`、`server/case.aggregate.ts`、`server/workflow.ts` |
| 06 受控执行与恢复 | `server/workflow.ts`、`server/business.ts`、`mcp/main.ts` |
| 07 复杂材料 | `server/investigation.service.ts`、`server/skills/material-review/SKILL.md` |
| 08 质量验证 | `server/evaluation.service.ts`、`server/trace.ts`、`test/` |
| 09 交付与技术取舍 | 本文件与 `docs/architecture.md` |

## 实现范围

政策库为少量可检查的教学文本。默认本地 BM25；显式启用 Milvus 后 AI 使用混合检索与精排。两种适配器都返回同一份政策类型，审批与执行不依赖检索后端。

MCP 子进程只提供订单、物流和退款查询/执行工具。客户确认申请、企业审批、版本递增和工作流恢复属于宿主应用的可信边界，不通过模型或 MCP 文本结果直接改变。

这是本地综合课程实现。账号选择器是教学身份入口；上线前应接入企业认证、访问审计、速率限制、数据保留策略和真实订单/支付适配器。生产部署可使用 `npm run build` 后设置 `NODE_ENV=production` 运行 `npm start`，由 API 同时提供静态页面；反向代理的公共地址配置 `PUBLIC_ORIGIN`，HTTPS 下设置 `COOKIE_SECURE=true`。生产环境须持久保存 PostgreSQL、`data/` 和 `workspaces/`。

前端、API、数据库默认端口分别为 `5190`、`4320`、`5441`。修改前两项时通过本项目 `.env` 中的 `WEB_PORT`、`PORT` 同时配置；数据库地址用 `POSTGRES_URI`。只修改 Vite 端口会导致代理和来源校验不一致。

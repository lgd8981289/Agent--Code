# Agent 质量评测竞技场

第十章 06～08 的独立项目。NestJS + Vue 3，比较轻量售后 Agent 的两个版本，保留评分依据、Trace 与发布检查结论。所有订单、审批、退款和记忆均为本地测试资料，不连接真实业务系统。

## 启动

Node.js >= 22.20。在本目录执行：

```bash
npm install
npm run dev
```

页面：http://localhost:5188 。API：`http://127.0.0.1:4318`。不依赖 Docker、数据库或 LangSmith。保留终端运行；Ctrl+C 停止。

默认 Replay 演示无需 Key。启动时 `.env not found. Continuing without it.` 是可选配置提醒。端口被占用时先停止本项目之前的开发进程，不要同时启动两份。

## 两种运行方式

- **Replay 演示**：`replay.ts` 提供脚本决策，执行真实的本地工具、消息转换、检查与 Trace 保存。回答引用实际工具消息，演示评分使用固定规则。不调用 LLM，不能用于比较模型能力。
- **真实模型**：调用 DeepSeek 获取决策，调用独立的 Judge 请求评阅回答，保存 API 实际用量。不读取评分 reference 作为 Agent 输入。真实结果存在波动，不保证复现演示分数。

使用真实模型时，在本目录自行准备 `.env`：

```dotenv
DEEPSEEK_API_KEY=你的_API_Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
JUDGE_MODEL=deepseek-flash
```

模型名以账号实际可用的 API model ID 为准。已有版本会保留创建时的模型名；修改环境变量后重启，再通过“复制为新版本”设置版本的模型字段。Key 只保存在服务端，不发送给页面或写入报告。

建议先在“测试数据集”勾选一条样本验证 API。一次评测会执行两个 Agent 版本，且可能额外调用 Judge，产生费用。`unsafe-tools` 故障配置只能用于 Replay，服务端拒绝在真实模型模式启用。

## 三条演示路线

左侧选择场景后，再点击“开始评测”。每条场景默认执行 13 道题 × 2 个版本。

| 场景 | 对比 | 内置演示的结果 |
| --- | --- | --- |
| 定位金额错误 | v1 → v2 | 9/13 → 13/13；工具返回 3500，v1 的消息转换变成 35 |
| 发现连续对话退步 | v2 → v3 | 13/13 → 12/13；v3 第二轮丢失历史消息 |
| 检查安全失败 | v2 → v4 | 13/13 → 9/13；4 条安全题失败，发布检查阻止通过 |

这些故障由应用配置主动触发，不代表真实模型必然犯错。Replay 安全题会主动发出恶意 Tool Call，验证工具防线与评分器，不用于测量模型抵抗提示注入的成功率。

点击表格的“通过 / 未通过”查看该版本详情；展开 Trace 中的工具、`buildToolMessage` 和下一次决策，核对数据变化。详情支持单题重跑、复制版本和人工复核。人工意见单独保留，不覆盖自动评分；候选存在质疑意见时，发布检查要求进一步核对。

## 评测约定

- 内置 7 条业务任务、4 条安全测试、2 条合法对照，共 13 条；连续追问在同一 session 内保留真实历史，偏好与污染样本切换 session 并保留该样本的记忆。
- 每个样本、每个版本各自创建独立业务数据，不共享退款或记忆残留。
- 参考要求仅供评分器使用；数据集可导出并按相同格式导入，新数据集创建独立版本。自定义题目仅支持真实模型模式。
- 每批冻结题目、配置、Judge 模型、评分器版本和代码摘要。旧版本与旧报告不随新版本变化。
- `failed` 是检查未通过；`agent_error` 是 Agent 未完整执行；`evaluation_error` 是评分调用失败；取消和中断不算通过。单个规则通过不能代表整题通过。
- 发布检查针对候选 B：完整内置回归集全部通过、无安全失败、无相对基线退步，且没有异常、缺失或待处理人工质疑。本项目策略较严格，生产阈值需按业务制定；不执行真实部署。
- 每次只允许一个活动批次，并发 1～2。单样本最多 180 秒、12 次决策、16 次工具调用，单轮最多 6 次决策，单次 API 超时 45 秒。取消会终止在途请求并取消排队样本，已经发生的 API 用量不保证撤销。
- Agent 与 Judge 分开统计实际 Token 和模型调用耗时。未知用量显示不完整；未配置价格，不估算金额费用。任务累计耗时不等于并发批次墙钟时间。

## 保存位置与实现入口

运行记录保存在 `data/arena.json`，采用临时文件替换。刷新页面可从历史打开；服务重启会将未完成批次标为 `interrupted`，保留已结束结果，重新评测需创建新批次。这个教学项目不实现重启后自动续跑。

```text
web/src/App.vue              页面入口：start() / 详情 / 版本 / 发布检查
server/main.ts              NestJS 路由与输入错误处理
server/arena.service.ts      批次快照、队列、持久化、比较与发布检查
server/runner.ts             执行单条样本、Trace、规则检查与 Judge
server/tools.ts              独立业务环境、工具权限、消息转换
server/replay.ts             明确标注的教学脚本及演示回答检查
server/dataset.ts            内置样本、Prompt 与版本预设
shared/contracts.ts         API 与数据集结构约束
```

## 验证

```bash
npm test
npm run build
```

自动测试使用固定脚本及本地 HTTP 模型替身，不加载 `.env`、不调用付费 API。覆盖业务任务、安全故障、上下文回归、消息转换、取消、发布检查以及真实 OpenAI SDK 的请求/响应处理路径。

`scripts/verify-ui.mjs` 是开发验收脚本，需要额外提供 Playwright 及浏览器。它在服务启动后执行页面操作并截图，默认写入 `test-artifacts/`；可用 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 指定本机安装位置。学生正常运行无需执行此脚本。

## 使用边界

这是本机单进程教学工作台，无用户登录和生产队列。只监听回环地址，勿直接暴露到公网；报告包含完整测试输入和 Trace，不应放入真实客户敏感信息。内置安全检查覆盖的是明确设计的测试攻击，不是通用安全扫描或绝对安全证明。LangSmith 未接入，核心执行与评分可在本地核对。

官方参考：[LangSmith Evaluation](https://docs.langchain.com/langsmith/evaluation-concepts)、[NestJS Controllers](https://docs.nestjs.com/controllers)、[Vue 3](https://vuejs.org/guide/quick-start.html)、[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。

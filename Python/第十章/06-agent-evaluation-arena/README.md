# Agent 评测竞技场 · Python 版

对应第十章 06 的独立项目，继续用于后续的评测运行与失败分析。提供版本对比、批量评测、Trace、人工复核、历史报告与发布检查。

后端由 NestJS 改为 **FastAPI + Uvicorn**，异步模型请求使用 HTTPX；Vue 3 页面保持原有交互。浏览器页面仍需要 Node.js 构建，但前后端源码、依赖、配置和数据均在本目录内，不读取 Node 课程目录。

## 文件职责

| 文件 | 作用 |
| --- | --- |
| `server/main.py` | HTTP 入口、本机访问限制、请求体大小限制 |
| `server/arena_service.py` | 版本与数据集、批次快照、并发队列、历史记录、发布检查 |
| `server/runner.py` | **重点**：多轮 Agent → 规则检查 → 独立 Judge，记录 Trace 与用量 |
| `server/tools.py` | **重点**：订单权限、偏好白名单、退款审批及幂等 |
| `server/replay.py` | 无 Key 的预设决策与演示评分 |
| `server/dataset.py`、`server/builtin_cases.json` | 13 道固定样本与 4 个教学版本 |
| `server/sample_guide.py` | 页面上的测试资料和检查说明，不发给答题 Agent |
| `server/cancellation.py`、`server/json_helpers.py` | 异步取消、JSON 与 Hash 的语言差异处理 |
| `shared/` | Python 严格输入校验与浏览器 TypeScript 合同 |
| `web/` | 独立 Vue 页面；Vite 只构建前端 |
| `test/`、`scripts/verify-*.mjs` | 离线测试、Node 行为基准与页面验证 |

## 离线启动

需要 Python 3.11+、uv、Node.js 22.20+ 和 npm。所有命令均在本小节目录执行：

```bash
cd "/Users/lgd_sunday/Desktop/Agent 全栈实战课/Code/Python/第十章/06-agent-evaluation-arena"
uv sync --locked
npm ci
npm run dev
```

打开 <http://localhost:5188>。后端监听 <http://127.0.0.1:4318>，页面通过 Vite 代理调用 `/api`。

默认选择 Replay 模式，不需要 API Key，也不调用模型。页面里的三个快捷场景分别演示：

| 场景 | 基准版本 → 候选版本 | 预期结果 |
| --- | --- | --- |
| 修复金额错误 | v1 → v2 | 9/13 → 13/13，发布检查通过 |
| 发现连续对话退步 | v2 → v3 | 13/13 → 12/13，发布检查不通过 |
| 检查安全失败 | v2 → v4 | 13/13 → 9/13，其中 4 条安全失败 |

每次完整评测执行 13 道题 × 2 个版本，共 26 条结果。点开“查询实付金额”的失败结果，可看到原始工具金额为 3500 元，经过 `buildToolMessage` 后错误地变为 35 元。

Replay 的工具、状态变化、规则检查和 Trace 都实际执行，但决策与回答评分是预设脚本。安全场景会主动尝试攻击调用，用于检验工具防线，不能据此衡量真实模型的抗攻击能力。

默认端口已被其他项目使用时，可以换一组端口，不需要停止原有服务：

```bash
PORT=4328 ARENA_WEB_PORT=5198 npm run dev
```

此时打开 <http://localhost:5198>。前端代理与后端 Origin 白名单会一起使用新端口。

## 真实模型模式

程序只读取启动进程的环境变量，不自动加载或改动任何环境文件。先在 shell 中设置 `DEEPSEEK_API_KEY`；如果你自己已经准备好了本目录下的 `.env`，可以手动加载它：

```bash
set -a
source .env
set +a
npm run dev
```

重启服务后，在页面切换“真实模型”再开始评测。该模式会产生真实 API 用量。

- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com`，请求路径为 `/chat/completions`。
- `DEEPSEEK_MODEL`：新版本的默认模型，默认 `deepseek-flash`。
- `JUDGE_MODEL`：独立评分模型，未设置时沿用 `DEEPSEEK_MODEL`。
- `ARENA_DATA_DIR`：报告存储目录，默认本小节下的 `data/`。
- `PORT` / `ARENA_WEB_PORT`：后端 / 前端端口，默认 4318 / 5188。

已有版本及评测保存的是当时的配置快照。更换环境变量不会改写历史版本；需要使用页面的“复制版本”建立新配置。自定义数据集只支持真实模型模式；`unsafe-tools` 版本仅用于 Replay，不允许调用真实模型。

## 运行与报告边界

同一时间只运行一个批次，批内并发可选 1～2。每条样本最多执行 180 秒、12 次决策、16 次工具调用，每轮最多 6 次决策；单次模型请求最多 45 秒且不自动重试。取消会中止等待中的 HTTP 请求和剩余队列，但已经发生的 API 消费不能撤销。

每个样本、每个版本都有独立模拟环境。同会话保留真实消息；切换会话只清空聊天，保留本题已写入的偏好和业务记录。退款不会触及真实资金。

历史记录原子写入 `data/arena.json`。正常关闭会收束运行任务；进程意外退出后，重启会把未完成批次标为“中断”，保留已完成结果，不自动重发模型请求。报告包含完整模拟业务数据与问题，请勿直接用于存放真实客户隐私。

发布检查要求内置完整回归集的候选版本全部通过、无安全失败、无退步、无执行或评分异常；部分样本、自定义集或人工质疑只能给出“需复核”。通过仅代表当前测试集检查通过，不会自动发布任何服务。

内置数据集 Hash 与原课程一致；`sourceHash` 则计算本目录 Python 实现及固定数据，用于标识真正运行的代码，因此与 Node 版本不同。

本服务仅供本机教学，无用户认证，不应直接开放到公网。Vite 开发代理会转发到本机 Python 后端；`npm run build` 仅生成前端静态产物，不会自动把后端变成生产部署。

## 验证

```bash
npm test
npm run build
```

测试使用临时目录和注入的假模型响应，不读取环境文件、不调用收费 API。包含 52 组 Node/Python Replay 完整业务与 Trace 基准对照、工具和输入校验、Agent/Judge 请求边界、取消、并发、历史恢复及 HTTP 访问限制。

页面验证脚本需要另外提供 Playwright 与 Chromium，并先启动本项目：

```bash
node scripts/verify-ui.mjs
node scripts/verify-config-ui.mjs
node scripts/verify-dataset-ui.mjs
```

可使用 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 指定现有测试运行时；`ARENA_WEB_URL` 指定测试页面地址，默认 `http://127.0.0.1:5188/`；`ARTIFACT_DIR` 指定截图目录。页面验证只应连接这个独立项目的测试实例，其中主流程脚本会创建 Replay 批次。

Python 依赖由 `pyproject.toml` / `uv.lock` 锁定，前端依赖由 `package.json` / `package-lock.json` 锁定，不需要 Docker、数据库或 LangSmith。

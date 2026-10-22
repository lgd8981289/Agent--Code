# 企业售后处理 Agent · Python 版

第十一章综合项目。Vue 3 页面配合独立 Python 后端，串起咨询、订单工具、政策检索、图片与语音、记忆、材料调查、人工审核、退款恢复和回归评测。

Replay 不调用模型，运行时仍使用真实 MCP 子进程、PostgreSQL 与 LangGraph 检查点。退款是独立的教学模拟业务。AI 咨询、图片、语音、调查与 Judge 会调用对应供应商并产生费用。

## 安装与离线验证

需要 Python 3.11+、uv；Vue 前端需要 Node.js 22.20+。本地 BM25 使用 ICU 中文词边界，与原例 `Intl.Segmenter` 一致；macOS 已内置，Debian / Ubuntu 可安装 `libicu-dev`。

以下命令在本节目录执行：

```bash
uv sync --locked
PYTHONDONTWRITEBYTECODE=1 uv run --locked python -m scripts.verify
npm --prefix web ci
npm --prefix web run build
```

离线测试使用临时目录、数据库替身、预设模型及真实 MCP stdio 协议，不连接业务数据库或收费接口。当前实现的十项业务回归应全部通过；注入金额单位故障的基线应只在金额项失败。测试会核对政策 Hash、ICU 分词和 BM25 排名。

## 启动完整项目

先准备 Docker Desktop，再执行：

```bash
docker compose --env-file /dev/null up -d --wait
uv run --locked python -m scripts.setup
uv run --locked python -m scripts.doctor
uv run --locked python -m scripts.dev
```

页面 [http://127.0.0.1:5190](http://127.0.0.1:5190)，API [http://127.0.0.1:4320/api/health](http://127.0.0.1:4320/api/health)。也可以分别启动 `python -m server.main` 和 `npm --prefix web run dev`。数据库默认监听 5441，连接默认值位于 `server/config.py`；Compose 项目名和 Volume 与其他语言版本隔离。

默认端口被占用时，在各终端导出相同的 `PORT` / `WEB_PORT` 后启动。数据库端口可用 `POSTGRES_PORT` 覆盖，并配套设置 `POSTGRES_URI`。不要把两个语言版本指向同一个业务数据库。停止数据库用 `docker compose --env-file /dev/null down`，保留 Volume。

配置只读取进程环境，Python、Vite 和上述 Compose 命令均不自动加载环境文件。已经有符合 shell 语法的 `.env` 时，可由你在启动终端加载：

```bash
set -a
source .env
set +a
uv run --locked python -m scripts.dev
```

AI 使用 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_MODEL`（默认 `deepseek-flash`）、`DEEPSEEK_BASE_URL`。图片和语音共用 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`（默认百炼兼容接口地址），`VISION_MODEL` 默认 `qwen3-vl-plus`。显式视觉模型不会自动换成其他模型；实时 ASR 需要导出完整的 `DASHSCOPE_BASE_URL`。仅显式执行 `python -m scripts.doctor --models` 才查询模型目录。

## 代表性演示

1. 选择「林晓 · 客户」和 Replay，发送 `A1024 咖啡机刚收到，外壳裂了，实付 3500 元，我想申请退款。`，核对订单和三类政策。
2. 添加演示照片并确认说明，核对金额后提交。状态为「等待审核」，此时没有退款回执。
3. 可重启 API 后继续。切换「周宁 · 售后审核」，批准当前版本后得到 **350000 分**的模拟退款；也可退回补充或拒绝。
4. 提交前选择「已受理，但响应丢失」，批准后进入「结果待核对」。点击继续会按原请求编号查询回执，最终仍只有一笔退款。
5. 运行材料调查，查看逐字引用、待核对问题和工作区产物。材料文字中的「已批准退款」不能代替审批记录。
6. 审核工作台中对比 Replay 基线和当前评测；AI 评测另加五道真实模型多轮任务，规则与 Judge 任一失败都会阻断门禁。

材料绑定订单；修改金额或确认材料会递增版本并使旧调查失效，需要重新确认。会话删除为软删除；申请撤回、偏好删除、列表筛选和 JSON 报告均保留。SSE 的段落增量仅供临时展示，`done` 才返回已保存会话。语音转写先进入输入框核对，朗读接口返回本地 `audio/wav` 字节。

## 文件职责与可选检索

- `server/app_controller.py`、`app_service.py`：HTTP / SSE、会话与草稿、材料确认。
- `server/case_service.py`、`case_aggregate.py`、`workflow.py`：申请版本、审批、持久化中断与回执核对。
- `mcp_server/`、`server/business.py`：独立 MCP 业务服务，再次校验身份、金额与审批。
- `server/knowledge/`、`knowledge/policies.json`：本地 BM25、目录版本核验与可选混合检索。
- `server/materials_service.py`、`voice/`、`investigation_service.py`、`evaluation/`：多模态、调查与评测。
- `web/`、`shared/`：独立 Vue 页面与请求契约；`data/materials/`、`workspaces/` 为运行产物。

Milvus 使用与服务端相匹配的 SDK，本节可选依赖锁定 PyMilvus 3.0.2。沿用已有 Milvus 时先确认版本及 BM25 / jieba 支持，配置 `KNOWLEDGE_BACKEND=milvus`、`MILVUS_ADDRESS`、可选 `MILVUS_TOKEN`、`AFTERSALES_POLICY_COLLECTION` 和 `ZHIPU_API_KEY`；可选 `ZHIPU_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`RERANK_MODEL` 的默认值见适配器。

```bash
uv sync --locked --extra milvus
PYTHONDONTWRITEBYTECODE=1 uv run --locked --extra milvus python -m scripts.verify
uv run --locked --extra milvus python -m scripts.index_policies
```

索引命令会调用收费 Embedding；AI 检索执行 Dense + BM25 → RRF → Rerank，并复核目录 Hash，Replay 始终使用本地检索。离线测试验证 SDK Schema、过滤与过期索引拒绝，不代表真实 Milvus 或云端效果已验证。

网页评测需要数据库账号有创建临时数据库的权限；评测结束会清理临时数据库和文件，报告保存在主库。需要重新录制演示时，先停止服务，再明确执行 `uv run --locked python -m scripts.reset_demo --yes`；该命令会删除本节默认数据库的演示记录及材料。

依赖由 `uv.lock` 和 `web/package-lock.json` 固定。本节不自动加载、创建或改动环境文件；相关 Git 忽略规则未改动。

官方参考：[LangGraph 持久化](https://docs.langchain.com/oss/python/langgraph/persistence)、[Deep Agents 文件后端](https://docs.langchain.com/oss/python/deepagents/backends)、[MCP Server](https://modelcontextprotocol.io/docs/develop/build-server)、[PyMilvus 版本匹配](https://milvus.io/docs/install-pymilvus.md)。

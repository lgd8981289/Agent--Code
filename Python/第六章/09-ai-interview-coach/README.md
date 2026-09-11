# AI 面试教练 Agent（Python 版）

这是第六章综合实战项目的 Python 版本。

它保留 Node 版本的核心能力：

- Thread 级会话恢复。
- 跨 Thread 长期记忆。
- 面试画像更新。
- 回答评估与薄弱点保存。
- 新会话针对薄弱点复测。
- 基于反馈依据的 Agentic RAG。

Python 版后端使用 FastAPI，前端使用静态 HTML/CSS/JS，不依赖 Node 构建链路。

## 文件说明

- `app.py`：FastAPI 应用入口，提供 `/api/*` 接口并托管静态页面。
- `auth.py`：演示用户和 `x-demo-token` 身份校验。
- `schemas.py`：接口和业务数据结构。
- `interview_service.py`：HTTP 操作、Session 和 Graph 之间的业务编排。
- `interview_graph.py`：本节核心文件，使用 LangGraph 组织出题、评估、补查依据、生成反馈和保存记忆。
- `memory.py`：用户画像、训练记忆、记忆阻断、Session 摘要和 Graph State 存取。
- `knowledge.py`：面试反馈依据知识库。
- `model_service.py`：Replay 模式评估规则和真实 DeepSeek 模型封装。
- `storage.py`：内存 Store 与 PostgreSQL Store。
- `setup_storage.py`：初始化 PostgreSQL 表结构。
- `doctor.py`：检查 PostgreSQL 连接和 AI 模式状态。
- `static/`：无需构建的页面演示代码。
- `tests/`：离线测试，不调用真实模型 API。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

如果使用 `uv`，可以直接运行后面的 `uv run ...` 命令。

## 离线验证

```bash
python -m unittest discover -s tests -v
```

或者：

```bash
uv run python -m unittest discover -s tests -v
```

测试使用内存 Store 和 Replay 模式，不调用 DeepSeek，也不连接 PostgreSQL。

## 本地项目演示

先启动 PostgreSQL：

```bash
docker compose up -d --wait
```

初始化表结构：

```bash
python setup_storage.py
```

检查运行环境：

```bash
python doctor.py
```

启动服务：

```bash
uvicorn app:app --reload --port 4310
```

浏览器打开：

```text
http://127.0.0.1:4310
```

默认使用 `replay` 模式，不需要模型密钥。它可以稳定复现“回答不完整 → 继续追问 → 保存薄弱点 → 新会话复测”的课程流程。

## 真实 AI 模式

如果要使用真实 DeepSeek，请先加载你已经准备好的环境变量：

```bash
set -a
source .env
set +a
```

也可以手动导出：

```bash
export MODEL_MODE=ai
export DEEPSEEK_API_KEY=你的真实 Key
export DEEPSEEK_MODEL=deepseek-v4-flash
export POSTGRES_URI=postgresql://interview_course:interview_course@localhost:5434/interview_coach
```

程序会读取：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`
- `POSTGRES_URI`，未设置时默认使用本节 Docker Compose 中的 PostgreSQL 地址

关键预期结果：在 Replay 模式下，提交不完整回答后，系统会给出反馈、补查两条课程依据，并把该知识点保存为 `needs_review`；随后点击“复习薄弱点”，会生成针对该薄弱点的复测题。

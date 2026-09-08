# Agentic RAG（Python 版）

本节演示如何把固定 RAG 流程升级成 Agentic RAG。

核心能力：

- 先判断问题是否真的需要查企业知识库。
- 需要检索时，先规划本轮需要哪些证据类型。
- 按证据类型逐步检索，缺哪类资料就补查哪类资料。
- 对检索结果做租户、状态、生效时间和证据类型校验。
- 证据不完整时拒答，不强行生成业务结论。
- 生成答案以后继续校验来源，避免模型引用不存在或不完整的资料。

## 文件说明

- `fixtures.py`：课程使用的固定身份、测试场景和模拟知识库资料。
- `knowledge.py`：知识库查询词构造、模拟检索和证据校验逻辑。
- `models.py`：DeepSeek 模型封装，以及 `decide / direct / answer` 三类模型服务。
- `workflow.py`：本节核心文件，使用 LangGraph 组织 Agentic RAG 的决策、检索、校验、补查、生成和拒答流程。
- `agentic_rag.py`：演示入口。
- `tests/test_workflow.py`：离线测试，不调用真实模型 API。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

如果你使用 `uv`，也可以直接在本目录执行后面的 `uv run ...` 命令。

## 离线验证

```bash
python -m unittest discover -s tests -v
```

或者：

```bash
uv run python -m unittest discover -s tests -v
```

这组测试使用固定模型替身，不调用 DeepSeek，也不访问真实知识库。

## 真实模型演示

如果当前目录已经配置好你自己的环境变量，可以先手动加载：

```bash
set -a
source .env
set +a
```

然后执行：

```bash
python agentic_rag.py multi
```

也可以切换其他场景：

```bash
python agentic_rag.py direct
python agentic_rag.py single
python agentic_rag.py clarify
python agentic_rag.py unknown
```

程序会读取：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

如果 `source .env` 报错，通常说明该文件不是标准 shell 变量格式。可以改为手动执行：

```bash
export DEEPSEEK_API_KEY=你的真实 Key
export DEEPSEEK_MODEL=deepseek-v4-flash
```

## 建议演示顺序

先运行离线测试，确认流程本身没有问题：

```bash
uv run python -m unittest discover -s tests -v
```

再选择 `multi` 场景演示完整 Agentic RAG：

```bash
uv run python agentic_rag.py multi
```

这个场景会先检索人工审核规则，再发现还缺少退款材料要求，然后继续补查第二类证据，最后基于两类有效证据生成带来源的答案。

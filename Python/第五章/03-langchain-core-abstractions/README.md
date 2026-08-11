# LangChain 核心抽象实验（Python 版）

这个案例分别运行 Chat Model、Message、Tool、手动 Tool Calling 和 RunnableSequence，不使用 `create_agent`。

## 文件说明

- `core_abstractions.py`：本节主代码，包含 5 个演示命令。
- `tests/test_core_abstractions.py`：离线验证 Tool 参数校验、任务查询和 RunnableSequence 固定流水线。
- `pyproject.toml`：Python 依赖声明。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 离线运行

`tool` 实验不调用模型，因此不需要 DeepSeek API Key：

```bash
python core_abstractions.py tool
```

关键预期结果：

- `DEV-1024` 能查询到任务标题、状态、负责人和截止时间；
- `1024` 会被 Tool Schema 拦截，因为它不符合 `DEV-数字` 的格式。

## 真实模型运行

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后按需运行：

```bash
python core_abstractions.py model
python core_abstractions.py stream
python core_abstractions.py calling
python core_abstractions.py runnable
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

## 验证

```bash
python -m compileall -q .
python -m unittest discover -s tests -v
```

离线测试不会调用真实 DeepSeek API。


# LangChain Python 最小 Agent

这个示例使用 LangChain Python、DeepSeek 和一个 `get_order_status` Tool，完成订单状态查询任务。

## 文件说明

- `langchain_agent.py`：本节主代码，包含 Tool、模型创建、Agent 创建和一次 Agent Run。
- `tests/test_langchain_agent.py`：离线验证 Tool 返回结构和结果解析逻辑。
- `pyproject.toml`：Python 依赖声明。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 运行

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后运行：

```bash
python langchain_agent.py
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

关键预期结果：模型会先提出 `get_order_status` Tool Call，LangChain 执行 Tool，把结果作为 ToolMessage 放回消息状态，再由模型生成最终回答。

## 验证

```bash
python -m compileall -q .
python -m unittest discover -s tests -v
```

离线测试不会调用真实 DeepSeek API。


# LangChain + LangGraph Workflow（Python 版）

本节演示如何用 LangGraph 组织确定性的业务流程，并在其中一个节点里调用 LangChain Agent。

核心效果：

- `DEV-1024`：任务进行中，进入内层 Agent 分析交付风险；
- `DEV-2048`：任务已完成，直接跳过 Agent；
- `DEV-9999`：任务不存在，直接跳过 Agent；
- 外层 Workflow 记录节点执行路径，内层 Agent 记录实际 Tool 调用路径。

## 文件说明

- `workflow_agent.py`：本节主代码，包含模拟业务数据、LangChain Tool、内层 Agent、外层 LangGraph Workflow 和命令入口。
- `tests/test_workflow_agent.py`：离线测试，使用 Fake Agent 验证路由、状态合并、Tool 路径提取和最终业务结果。
- `pyproject.toml`：Python 依赖声明。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 离线运行

`routes` 和 `mermaid` 不会进入真实模型：

```bash
python workflow_agent.py routes
python workflow_agent.py mermaid
```

也可以运行离线测试：

```bash
python -m unittest discover -s tests -v
```

## 真实模型运行

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后运行完整 demo：

```bash
python workflow_agent.py demo
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

关键预期结果：完成任务和不存在任务不会消耗模型调用；只有进行中的 `DEV-1024` 会进入内层 Agent。

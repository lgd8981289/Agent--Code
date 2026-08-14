# LangChain Middleware（Python 版）

这个案例在第五章 05 小节的研发任务风险分析 Agent 上继续增加：

- 根据 Runtime Context 动态过滤 Tool；
- 在 Tool 执行前再次校验角色权限；
- 限制单次 Agent Run 的模型与 Tool 调用次数；
- 校验 Tool 返回结果，并对暂时性错误自动重试。

## 文件说明

- `middleware_agent.py`：本节主代码，包含业务数据、Tool、权限 Middleware、结果校验 Middleware、内置调用预算和重试 Middleware。
- `tests/test_middleware_agent.py`：离线验证权限过滤、执行前权限兜底、测试报告结构校验、自动重试判断和运行上下文。
- `pyproject.toml`：Python 依赖声明。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 真实模型运行

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后运行完整实验：

```bash
python middleware_agent.py demo
```

也可以单独运行某组实验：

```bash
python middleware_agent.py permission
python middleware_agent.py retry
python middleware_agent.py budget
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

## 关键预期结果

- `developer` 只能看到 `get_task` 和 `get_latest_test_report`；
- `maintainer` 还能看到 `get_failure_detail`；
- 测试报告第一次返回残缺数据时，会被校验 Middleware 拒绝，并交给重试 Middleware 再执行一次；
- 模型调用和 Tool 调用超过预算时，Agent 会停止。

## 验证

```bash
python -m compileall -q .
python -m unittest discover -s tests -v
```

离线测试不会调用真实 DeepSeek API。


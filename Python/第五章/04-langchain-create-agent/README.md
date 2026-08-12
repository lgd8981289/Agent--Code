# create_agent Runtime 多轮执行案例（Python 版）

这个案例让 Agent 分别查询研发任务和最新测试报告，再根据两份数据判断任务是否存在延期风险。

第二个 Tool 所需的 `repository` 来自第一个 Tool，因此 Agent 必须经历多轮“模型决策 → Tool 执行 → 结果回传”才能完成任务。

## 文件说明

- `create_agent_demo.py`：本节主代码，演示 `create_agent` 多轮 Tool Calling 和三种 Stream 观察方式。
- `tests/test_create_agent_demo.py`：离线验证 Tool 数据、Tool 依赖链、updates 处理和最终 Message 轨迹格式。
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

然后运行：

```bash
python create_agent_demo.py
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

## 运行效果

这一次执行会同时展示：

- `updates`：Model 和 Tools 每一步完成后的状态更新；
- `messages`：模型生成的最终回答；
- `custom`：Tool 主动发送的查询进度；
- 最终 Message 轨迹：本次 Agent Run 中依次产生的 AIMessage 和 ToolMessage。

## 验证

```bash
python -m compileall -q .
python -m unittest discover -s tests -v
```

离线测试不会调用真实 DeepSeek API。


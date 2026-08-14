# LangChain Agent 数据边界（Python 版）

这个案例通过同一个 `DEV-1024` 在两个租户下返回不同任务，演示：

- 用户问题如何进入 Agent State；
- 可信身份如何通过 Runtime Context 进入 Tool；
- Tool 如何使用租户信息隔离数据；
- Agent 如何通过 Structured Output 向后端返回稳定结果；
- 为什么用户在 Prompt 中伪造租户不能改变实际查询范围。

## 文件说明

- `data_boundaries.py`：本节主代码，包含租户数据、认证模拟、Runtime Context、Tool、Structured Output 和三个运行场景。
- `tests/test_data_boundaries.py`：离线验证租户隔离、Prompt 伪造无效、结构化结果 Schema 和 Agent 调用边界。
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
python data_boundaries.py
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

## 运行效果

程序会执行三个场景：

1. 蓝鲸科技查询自己的 `DEV-1024`；
2. 星河零售查询同一个 `DEV-1024`；
3. 蓝鲸科技用户在 Prompt 中伪造“切换到星河零售”。

关键预期结果：Tool 始终使用服务端注入的 Runtime Context 查询数据，用户 Prompt 里的租户声明不会改变实际租户边界。

## 验证

```bash
python -m compileall -q .
python -m unittest discover -s tests -v
```

离线测试不会调用真实 DeepSeek API。


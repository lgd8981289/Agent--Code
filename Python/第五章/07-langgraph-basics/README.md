# LangGraph 基础：State、Node、Edge 与 Conditional Edge（Python 版）

这一节使用 LangGraph 实现一个研发任务分流 Graph。

它会根据任务状态进入不同分支：

- `DEV-1024`：任务进行中，进入 `active` 分支；
- `DEV-2048`：任务已完成，进入 `completed` 分支；
- `DEV-9999`：任务不存在，进入 `missing` 分支。

## 文件说明

- `task_routing_graph.py`：本节主代码，包含 State 定义、Node、Conditional Edge、Reducer、`invoke()`、`stream()` 和 Mermaid 输出。
- `tests/test_task_routing_graph.py`：离线验证三条分支、执行路径累积、stream 更新和 Mermaid 结构。
- `pyproject.toml`：Python 依赖声明。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 运行

执行三条分支：

```bash
python task_routing_graph.py demo
```

观察每一步 Node 对 State 的增量更新：

```bash
python task_routing_graph.py stream
```

输出 Graph 的 Mermaid 结构：

```bash
python task_routing_graph.py mermaid
```

## 关键预期结果

执行 `demo` 时，三个任务会分别输出：

- `DEV-1024`：`load_task -> handle_active`
- `DEV-2048`：`load_task -> handle_completed`
- `DEV-9999`：`load_task -> handle_missing`

## 验证

```bash
python -m compileall -q .
python -m unittest discover -s tests -v
```

本节不需要真实模型，也不需要外部 API。

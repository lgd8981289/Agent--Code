# Memory Extraction（Python 版）

本节演示从对话中提取候选长期记忆，并在写入 Store 前进行策略审核。

关键点：模型只负责提出候选；最终是否写入长期记忆，由确定性代码根据用户授权、来源、证据、保存范围和敏感信息策略决定。

## 文件说明

- `conversation.py`：模拟对话、用户身份和 replay 候选记忆。
- `memory_extractor.py`：使用 DeepSeek 结构化输出提出候选记忆。
- `memory_policy.py`：审核候选记忆是否允许写入。
- `memory_store.py`：把审核通过的候选写入 LangGraph Store。
- `memory_extraction.py`：本节主流程入口，支持 replay、ai、no-consent 三种模式。
- `tests/test_memory_extraction.py`：离线测试，不调用真实 DeepSeek API。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 离线运行

```bash
python memory_extraction.py replay
python memory_extraction.py no-consent
python -m unittest discover -s tests -v
```

`replay` 和 `no-consent` 不需要模型 API Key，也不会连接外部数据库。

关键预期结果：`replay` 模式下只会写入第一条候选记忆；来自 assistant 推测、当前任务要求、未确认转述和敏感信息都会被拒绝。`no-consent` 模式下所有候选都会被拒绝。

## 真实模型运行

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后运行：

```bash
python memory_extraction.py ai
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

真实模型模式只负责生成候选记忆；候选仍然会经过 `memory_policy.py` 的确定性审核，只有审核通过的内容才会写入 Store。

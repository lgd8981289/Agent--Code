# Long Conversation Context（Python 版）

本节演示长对话上下文的三种处理方式：

- 完整保留历史消息；
- 直接裁剪，只保留近期消息；
- 将较早历史压缩成摘要，再拼接近期消息。

关键点：直接裁剪能缩小输入，但可能丢掉早期关键事实；摘要压缩可以在缩小上下文的同时保留订单号、金额、材料状态和用户限制。

## 文件说明

- `context.py`：公共上下文函数，包含长对话构造、上下文规模估算、近期消息裁剪和确定性摘要上下文。
- `compare_context.py`：离线对比三种上下文处理策略。
- `automatic_compaction.py`：使用 LangChain `SummarizationMiddleware` 演示自动摘要压缩。
- `tests/test_context.py`：离线测试，使用 Fake Model，不调用真实 DeepSeek API。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 离线运行

```bash
python compare_context.py
python -m unittest discover -s tests -v
```

`compare_context.py` 不需要模型 API Key。

## 真实模型运行

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后运行自动摘要实验：

```bash
python automatic_compaction.py
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

关键预期结果：第五轮进入模型以前会触发摘要压缩，State 中会出现带有 `lc_source=summarization` 标记的摘要消息。

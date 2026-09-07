# Memory Recall（Python 版）

本节演示如何在一次回答前读取长期记忆，并把真正可用的记忆组装进本轮模型输入。

核心流程：

- 精确读取回答偏好，例如语言和表达风格。
- 对历史事件做语义召回。
- 对召回候选继续检查删除、过期、状态、来源、revision、分数、TopK 和字符预算。
- 使用当前订单和现行规则计算业务判断，不从历史记忆推断本次结果。
- 只组装本次 messages，不把召回结果写回 Thread State。

## 文件说明

- `fixtures.py`：模拟当前会话、用户记忆和已核验业务资料。
- `models.py`：智谱 Embedding 和 DeepSeek 回答模型封装。
- `recall.py`：精确读取、语义召回、筛选和 messages 组装，是本节核心文件。
- `memory_recall.py`：演示入口。
- `tests/test_recall.py`：离线测试，使用固定向量替身，不调用外部 API。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 离线验证

```bash
python -m unittest discover -s tests -v
```

测试使用固定向量替身，不调用智谱、DeepSeek、数据库或订单系统。

## 真实召回演示

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后运行：

```bash
python memory_recall.py
```

脚本会读取：

- `ZHIPU_API_KEY`
- `EMBEDDING_MODEL`，未设置时默认使用 `embedding-3`
- `EMBEDDING_DIMENSIONS`，未设置时默认使用 `512`

关键预期结果：程序会打印本次问题、精确读取的回答偏好、历史记忆候选与筛选原因、最终入选的历史记忆，以及真正准备发送给模型的 messages。

## 真实回答演示

```bash
python memory_recall.py answer
```

`answer` 模式会在召回和 Context 组装之后继续调用 DeepSeek。除了上面的 Embedding 变量外，还会读取：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`

本节使用 `InMemoryStore` 便于独立运行，不需要 Docker 或 PostgreSQL，进程结束后数据消失。

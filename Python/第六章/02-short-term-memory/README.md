# Short-term Memory（Python 版）

本节演示 LangChain Agent 如何通过 Checkpointer 保存短期会话记忆。

核心效果：

- 相同 `thread_id` 可以接续上一轮会话 State；
- 不同 `thread_id` 之间相互隔离；
- 已知 `thread_id` 也不能绕过用户归属校验；
- `MemorySaver` 适合单进程演示；
- `PostgresSaver` 可以把 Thread State 保存到 PostgreSQL，支持跨进程恢复。

## 文件说明

- `session.py`：通用会话能力，包含模型创建、Agent 创建、Thread 权限校验和 State 打印。
- `memory_session.py`：使用进程内 `InMemorySaver` 演示短期记忆。
- `postgres_session.py`：使用 PostgreSQL Checkpointer 演示跨进程恢复。
- `docker-compose.yml`：本节 PostgreSQL 本地实验环境。
- `tests/`：离线测试，使用 Fake Model 和 Fake Checkpointer，不调用真实模型，不连接真实数据库。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 进程内短期记忆演示

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后运行：

```bash
python memory_session.py
```

关键预期结果：同一个 Thread 的第二轮会看到 4 条消息；另一个 Thread 只会看到当前会话自己的消息。

## PostgreSQL 跨进程演示

先启动本节 PostgreSQL：

```bash
docker compose up -d
```

然后依次执行：

```bash
python postgres_session.py reset
python postgres_session.py write
python postgres_session.py continue
python postgres_session.py unauthorized
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`
- `POSTGRES_URI`，未设置时默认使用本节 `docker-compose.yml` 中的本地 PostgreSQL

## 离线验证

```bash
python -m compileall -q .
python -m unittest discover -s tests -v
docker compose config
```

离线测试不会调用真实 DeepSeek API，也不会连接真实 PostgreSQL。

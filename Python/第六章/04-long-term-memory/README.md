# Long-term Memory（Python 版）

本节演示 LangChain / LangGraph 中的长期记忆：

- `Checkpointer` 保存 Thread 内的短期 State；
- `Store` 保存跨 Thread 的长期用户画像；
- 用户画像通过 `Namespace + Key` 定位；
- Namespace 使用 `tenantId + userId`，不包含 `thread_id`；
- 同一用户可以跨会话读取画像，不同用户或不同租户互相隔离。

## 文件说明

- `profile_store.py`：用户画像 Store 封装，包含 Namespace 生成、保存、读取和删除。
- `store_basics.py`：不调用模型，只用内存 Store 验证 `Namespace + Key -> Value`。
- `storage.py`：创建 PostgreSQL Checkpointer 和 Store。
- `setup_storage.py`：初始化 PostgreSQL 中 Checkpointer 和 Store 需要的数据表。
- `profile_agent.py`：使用 Tool 写入和读取用户画像。
- `docker-compose.yml`：本节 PostgreSQL 本地实验环境。
- `tests/test_profile_store.py`：离线测试，使用 `InMemoryStore` 和 Fake Model，不连接真实数据库。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 离线运行

```bash
python store_basics.py
python -m unittest discover -s tests -v
```

`store_basics.py` 不需要模型 API Key，也不需要 PostgreSQL。

## PostgreSQL 初始化

先启动本节 PostgreSQL：

```bash
docker compose up -d
```

如果当前目录已经有你自己的 `.env`，可以先手动加载环境变量：

```bash
set -a
source .env
set +a
```

然后初始化表结构：

```bash
python setup_storage.py
```

脚本会读取：

- `POSTGRES_URI`

## 真实模型运行

```bash
python profile_agent.py reset
python profile_agent.py remember
python profile_agent.py recall
python profile_agent.py isolation
```

也可以运行完整流程：

```bash
python profile_agent.py demo
```

脚本会读取这些环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`，未设置时默认使用 `deepseek-v4-flash`
- `POSTGRES_URI`

关键预期结果：`remember` 会把用户偏好写入 Store；`recall` 会在新 Thread 中读取同一份用户画像；`isolation` 会显示其他用户或其他租户读取不到该画像。

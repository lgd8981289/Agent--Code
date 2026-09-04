"""
PostgreSQL 存储组件。

本文件对应 Node 版的 storage.js。

Checkpointer 负责短期 Thread State，
Store 负责跨 Thread 的长期用户画像。
二者可以共用同一个 PostgreSQL 连接地址，
但在 LangGraph 中属于两个不同的存储职责。
"""

from __future__ import annotations

import os
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Any


def get_postgres_uri() -> str:
    """读取本节共用的 PostgreSQL 连接地址。"""

    postgres_uri = os.getenv("POSTGRES_URI")

    if not postgres_uri:
        raise RuntimeError("缺少 POSTGRES_URI，请先加载你已有的 .env。")

    return postgres_uri


@dataclass
class Storage:
    """分别负责短期状态和长期记忆的 PostgreSQL 组件。"""

    checkpointer: Any
    store: Any
    exit_stack: ExitStack


def create_storage() -> Storage:
    """创建分别负责短期状态和长期记忆的 PostgreSQL 组件。"""

    uri = get_postgres_uri()

    try:
        from langgraph.checkpoint.postgres import PostgresSaver
        from langgraph.store.postgres import PostgresStore
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langgraph-checkpoint-postgres 依赖，请先执行：python -m pip install -e ."
        ) from exc

    exit_stack = ExitStack()

    try:
        checkpointer = exit_stack.enter_context(PostgresSaver.from_conn_string(uri))
        store = exit_stack.enter_context(PostgresStore.from_conn_string(uri))
    except Exception:
        exit_stack.close()
        raise

    return Storage(
        checkpointer=checkpointer,
        store=store,
        exit_stack=exit_stack,
    )


def close_storage(storage: Storage) -> None:
    """关闭 Store 和 Checkpointer 各自持有的数据库连接。"""

    storage.exit_stack.close()

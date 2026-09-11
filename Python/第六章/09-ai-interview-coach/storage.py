"""AI 面试教练的存储层。

Node 版使用 LangGraph 的 PostgresSaver 和 PostgresStore。
Python 版为了让课程结构更清晰，把“Graph 状态快照”和“长期记忆 Store”
统一保存到一个简单 KV 表中：

    Namespace + Key -> JSON Value

业务语义保持一致：

- sessionId 对应可恢复的 Thread 状态；
- profile / learning-memories 跨 Thread 共享；
- 不同 tenantId / userId 之间互相隔离。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


DEFAULT_POSTGRES_URI = (
    "postgresql://interview_course:interview_course@localhost:5434/interview_coach"
)


@dataclass
class StoreItem:
    key: str
    value: dict[str, Any]


class InMemoryStore:
    """测试和轻量演示使用的内存 Store。"""

    def __init__(self):
        self._data: dict[tuple[tuple[str, ...], str], dict[str, Any]] = {}

    def setup(self) -> None:
        """内存 Store 不需要初始化表结构。"""

    def close(self) -> None:
        """内存 Store 不持有外部连接。"""

    def get(self, namespace: list[str] | tuple[str, ...], key: str) -> StoreItem | None:
        value = self._data.get((tuple(namespace), key))
        return StoreItem(key=key, value=dict(value)) if value is not None else None

    def put(
        self,
        namespace: list[str] | tuple[str, ...],
        key: str,
        value: dict[str, Any],
    ) -> None:
        self._data[(tuple(namespace), key)] = dict(value)

    def delete(self, namespace: list[str] | tuple[str, ...], key: str) -> None:
        self._data.pop((tuple(namespace), key), None)

    def search(
        self,
        namespace: list[str] | tuple[str, ...],
        *,
        limit: int = 100,
    ) -> list[StoreItem]:
        prefix = tuple(namespace)
        results = [
            StoreItem(key=key, value=dict(value))
            for (stored_namespace, key), value in self._data.items()
            if stored_namespace == prefix
        ]
        return results[:limit]


class PostgresKVStore:
    """PostgreSQL 版 KV Store，用于本地完整项目演示。"""

    def __init__(self, uri: str):
        self.uri = uri
        self.connection = None

    def _connect(self):
        if self.connection is None:
            try:
                import psycopg
            except ImportError as exc:
                raise RuntimeError(
                    "缺少 psycopg 依赖，请先执行：python -m pip install -e ."
                ) from exc

            self.connection = psycopg.connect(self.uri)

        return self.connection

    def setup(self) -> None:
        connection = self._connect()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS interview_course_kv_store (
                    namespace TEXT[] NOT NULL,
                    key TEXT NOT NULL,
                    value JSONB NOT NULL,
                    PRIMARY KEY (namespace, key)
                )
                """
            )
        connection.commit()

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def get(self, namespace: list[str] | tuple[str, ...], key: str) -> StoreItem | None:
        connection = self._connect()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT key, value
                FROM interview_course_kv_store
                WHERE namespace = %s AND key = %s
                """,
                (list(namespace), key),
            )
            row = cursor.fetchone()

        if not row:
            return None

        return StoreItem(key=row[0], value=row[1])

    def put(
        self,
        namespace: list[str] | tuple[str, ...],
        key: str,
        value: dict[str, Any],
    ) -> None:
        try:
            from psycopg.types.json import Jsonb
        except ImportError as exc:
            raise RuntimeError(
                "缺少 psycopg 依赖，请先执行：python -m pip install -e ."
            ) from exc

        connection = self._connect()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO interview_course_kv_store (namespace, key, value)
                VALUES (%s, %s, %s)
                ON CONFLICT (namespace, key)
                DO UPDATE SET value = EXCLUDED.value
                """,
                (list(namespace), key, Jsonb(value)),
            )
        connection.commit()

    def delete(self, namespace: list[str] | tuple[str, ...], key: str) -> None:
        connection = self._connect()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                DELETE FROM interview_course_kv_store
                WHERE namespace = %s AND key = %s
                """,
                (list(namespace), key),
            )
        connection.commit()

    def search(
        self,
        namespace: list[str] | tuple[str, ...],
        *,
        limit: int = 100,
    ) -> list[StoreItem]:
        connection = self._connect()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT key, value
                FROM interview_course_kv_store
                WHERE namespace = %s
                ORDER BY key
                LIMIT %s
                """,
                (list(namespace), limit),
            )
            rows = cursor.fetchall()

        return [StoreItem(key=row[0], value=row[1]) for row in rows]


def create_storage() -> PostgresKVStore:
    """创建默认 PostgreSQL 存储。

    POSTGRES_URI 未设置时，使用和 Node 课程一致的本地 Docker 地址。
    """

    return PostgresKVStore(os.getenv("POSTGRES_URI", DEFAULT_POSTGRES_URI))

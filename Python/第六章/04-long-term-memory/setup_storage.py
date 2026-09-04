"""
初始化 PostgreSQL 中 Checkpointer 和 Store 需要的数据表。
"""

from __future__ import annotations

import sys
from contextlib import ExitStack

from storage import get_postgres_uri


def main() -> None:
    """第一次运行项目前，创建 Checkpointer 和 Store 需要的数据表。"""

    uri = get_postgres_uri()

    try:
        from langgraph.checkpoint.postgres import PostgresSaver
        from langgraph.store.postgres import PostgresStore
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langgraph-checkpoint-postgres 依赖，请先执行：python -m pip install -e ."
        ) from exc

    with ExitStack() as stack:
        checkpointer = stack.enter_context(PostgresSaver.from_conn_string(uri))
        store = stack.enter_context(PostgresStore.from_conn_string(uri))

        checkpointer.setup()
        store.setup()
        print("Checkpointer 与 Store 数据表初始化完成。")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)

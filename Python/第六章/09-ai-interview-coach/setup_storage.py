"""初始化 AI 面试教练使用的 PostgreSQL 表结构。"""

from __future__ import annotations

from storage import create_storage


def main() -> None:
    storage = create_storage()

    try:
        storage.setup()
        print("数据库表结构初始化完成。")
    finally:
        storage.close()


if __name__ == "__main__":
    main()

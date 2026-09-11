"""检查本地项目运行依赖。"""

from __future__ import annotations

import os

from storage import create_storage


def main() -> None:
    storage = create_storage()

    try:
        storage.setup()
        print("✓ PostgreSQL 连接正常")
        print(
            f"✓ AI 模式可用：{os.getenv('DEEPSEEK_MODEL', 'deepseek-v4-flash')}"
            if os.getenv("DEEPSEEK_API_KEY")
            else "· 未配置 DEEPSEEK_API_KEY，将使用 Replay 模式"
        )
    finally:
        storage.close()


if __name__ == "__main__":
    main()

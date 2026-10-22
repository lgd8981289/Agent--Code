"""显式初始化业务表、LangGraph 检查点和长期记忆。"""

import asyncio
from server.storage import Storage


async def main():
    db = Storage()
    try:
        await db.open()
        await db.setup()
        print("PostgreSQL 业务表、LangGraph Checkpoint 与长期记忆已初始化。已有订单与申请不会被覆盖。")
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())

"""只在用户明确执行 --yes 且开发服务停止时重置本节默认演示库。"""

import argparse
import asyncio
import shutil
from urllib.request import urlopen
from psycopg import sql
from server.common import require
from server.config import Config
from server.storage import Storage


async def main(confirmed):
    require(confirmed, "此操作删除本节会话、申请、退款、偏好、材料与评测；请先停止服务，再明确执行 --yes")
    config = Config()
    try:
        with urlopen(f"http://127.0.0.1:{config.port}/api/health", timeout=1.5) as response:
            require(response.status != 200, "请先停止本项目的开发服务，再重置演示")
    except OSError:
        pass
    db = Storage(config.database_url)
    try:
        await db.open()
        require((await db.query("SELECT current_database() AS name"))[0]["name"] == "aftersales_agent", "重置脚本仅允许操作默认 aftersales_agent 数据库")
        tables = {r["tablename"] for r in await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")}
        allowed = [n for n in ("af_records", "af_refunds", "af_sessions", "checkpoints", "checkpoint_writes", "checkpoint_blobs", "store") if n in tables]
        if allowed:
            await db.query(sql.SQL("TRUNCATE {} CASCADE").format(sql.SQL(",").join(sql.Identifier(n) for n in allowed)))
        for name in ("data/materials", "workspaces"):
            path = config.root / name
            if path.exists():
                shutil.rmtree(path)
        await db.setup()
        print("演示数据已重置，签收时间和剩余可退金额已重新准备。")
    finally:
        await db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--yes", action="store_true")
    asyncio.run(main(parser.parse_args().yes))

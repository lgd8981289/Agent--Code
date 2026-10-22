"""仅测试调用：真实 MCP 协议与业务实现，进程内内存存储，无外部连接。"""

import asyncio
import os
from mcp.server.stdio import stdio_server
from mcp_server.main import create_server
from server.business import Business
from server.fixtures import ACCOUNTS
from .support import MemoryStorage


async def main():
    db = MemoryStorage()
    await db.reset_evaluation()
    actor = next(a for a in ACCOUNTS if a["id"] == os.environ["MCP_ACTOR_ID"])
    server = create_server(Business(db), actor)
    async with stdio_server() as (reader, writer):
        await server.run(reader, writer, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())

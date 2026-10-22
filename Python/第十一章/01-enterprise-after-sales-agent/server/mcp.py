"""每个客户一个真实 stdio MCP 子进程，身份由宿主设置，模型不能传入身份。

Python SDK 的 stdio 上下文含 AnyIO cancel scope，连接和关闭必须在同一任务中。
因此由常驻任务管理连接，用队列分发工具调用，不跨任务进入/退出上下文。
"""

import asyncio
import json
import os
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from shared.business_tools import parse_tool_output
from .config import Config, ROOT


class McpBridge:
    def __init__(self, config=None, overrides=None):
        self.config, self.overrides = config or Config(), overrides or {}
        self.clients, self.closing = {}, False

    async def worker(self, actor, queue):
        current = None
        try:
            parameters = StdioServerParameters(command=sys.executable, args=["-m", "mcp_server.main"],
                cwd=str(ROOT), env={**os.environ, **self.config.env, **self.overrides, "MCP_ACTOR_ID": actor["id"], "PYTHONDONTWRITEBYTECODE": "1"})
            async with stdio_client(parameters) as (reader, writer):
                async with ClientSession(reader, writer) as session:
                    await session.initialize()
                    while (current := await queue.get()) is not None:
                        name, args, future = current
                        if future.cancelled():
                            continue
                        try:
                            response = await session.call_tool(name, arguments=args, read_timeout_seconds=20)
                            value = json.loads("\n".join(b.text for b in response.content if b.type == "text"))
                            if response.is_error:
                                raise ValueError(value.get("error", "业务工具执行失败"))
                            result = parse_tool_output(name, value)
                            if not future.done():
                                future.set_result(result)
                        except Exception as error:
                            if not future.done():
                                # 不把活跃连接任务的 traceback 交给另一个任务。
                                # 测试/日志清理异常帧时，不能顺带清掉仍在运行的 stdio 上下文。
                                failure = ValueError(str(error)) if isinstance(error, ValueError) else RuntimeError(str(error))
                                future.set_exception(failure)
        except BaseException as error:
            failure = RuntimeError(f"MCP 连接失败：{error}")
            if current is not None and not current[2].done():
                current[2].set_exception(failure)
            while not queue.empty():
                pending = queue.get_nowait()
                if pending and not pending[2].done():
                    pending[2].set_exception(failure)
        finally:
            connection = self.clients.get(actor["id"])
            if connection and connection[1] is asyncio.current_task():
                self.clients.pop(actor["id"], None)

    async def call(self, actor, name, args=None):
        if self.closing:
            raise RuntimeError("MCP 服务正在关闭")
        if actor["id"] not in self.clients:
            queue = asyncio.Queue()
            task = asyncio.create_task(self.worker(actor, queue))
            self.clients[actor["id"]] = queue, task
        queue, _ = self.clients[actor["id"]]
        future = asyncio.get_running_loop().create_future()
        await queue.put((name, args or {}, future))
        return await asyncio.wait_for(future, timeout=25)

    async def close(self):
        self.closing = True
        connections = list(self.clients.values())
        for queue, _ in connections:
            await queue.put(None)
        for _, task in connections:
            try:
                await asyncio.wait_for(task, 5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.clients.clear()

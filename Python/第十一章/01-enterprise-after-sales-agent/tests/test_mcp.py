import asyncio
import os
import sys
import unittest
from unittest.mock import patch
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from server.config import Config, ROOT
from server.fixtures import ACCOUNTS
from server.mcp import McpBridge


class McpTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_protocol_and_bridge_lifecycle(self):
        # 生产 Bridge 与生产 Server 都真实执行，只替换子进程的数据库组合入口。
        import server.mcp as module
        original = module.StdioServerParameters
        def parameters(**kwargs):
            kwargs["args"] = ["-m", "tests.mcp_fixture"]
            return original(**kwargs)
        bridge = McpBridge(Config({"LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false"}))
        with patch.object(module, "StdioServerParameters", side_effect=parameters):
            try:
                a, b = await asyncio.gather(bridge.call(ACCOUNTS[0], "get_order", {"orderId": "A1024"}), bridge.call(ACCOUNTS[1], "list_orders"))
                self.assertEqual(a["paidCents"], 350000)
                self.assertEqual([o["id"] for o in b], ["A1025"])
                with self.assertRaisesRegex(ValueError, "无权"):
                    await bridge.call(ACCOUNTS[0], "get_order", {"orderId": "A1025"})
                with self.assertRaisesRegex(ValueError, "参数"):
                    await bridge.call(ACCOUNTS[0], "get_order", {"orderId": "A1024", "userId": "chen"})
                self.assertEqual(len(bridge.clients), 2)
            finally:
                await bridge.close()
        self.assertEqual(bridge.clients, {})

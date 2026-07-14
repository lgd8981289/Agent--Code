"""通过最小订单案例理解 MCP Host、Client 和 Server。"""

from __future__ import annotations

import asyncio
import json
import pprint
import sys
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


# 获取订单 MCP Server 入口文件的绝对路径。
#
# Path(__file__).resolve() 表示当前文件地址；
# with_name(...) 根据当前文件定位 order_mcp_server.py。
server_path = Path(__file__).resolve().with_name("order_mcp_server.py")


def print_step(title: str) -> None:
    """打印步骤标题，方便观察 Host、Client 和 Server 之间的调用过程。"""

    print(f"\n================ {title} ================")


def to_plain(value: Any) -> Any:
    """把 MCP SDK 返回的 Pydantic 对象转换成普通 dict，方便打印。"""

    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True)
    return value


def text_content_to_json(result: Any) -> dict[str, Any] | None:
    """从 MCP Tool 返回的 content 数组中找到文本类型结果并解析 JSON。"""

    for item in result.content:
        if getattr(item, "type", None) == "text":
            return json.loads(item.text)
    return None


async def main() -> None:
    """启动 Host，并通过 MCP Client 调用订单 MCP Server。"""

    # 创建 stdio Client 传输层。
    #
    # sys.executable：当前运行程序所使用的 Python 可执行文件；
    # args：传给 Python 的启动参数，这里是 Server 入口文件。
    #
    # 连接时相当于执行：
    #
    # python order_mcp_server.py
    server_params = StdioServerParameters(
        command=sys.executable,
        args=[str(server_path)],
    )

    print_step("1. Host 启动")

    # 当前文件中的 Agent 调度逻辑属于 Host。
    print("[Host] 售后 Agent 开始处理订单查询任务")
    print("[Host] 创建 MCP Client，并指定要连接的订单 Server")

    print_step("2. Client 建立连接")

    # 启动订单 MCP Server 子进程，
    # 并通过 stdio 完成 MCP 初始化和连接握手。
    async with stdio_client(server_params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as client:
            await client.initialize()

            print("[Client] 已连接订单 MCP Server")

            print_step("3. Client 发现能力")

            # 向 Server 查询当前可以使用的 MCP Tools。
            list_result = await client.list_tools()

            print("[Client] Server 当前提供的工具：")

            # 打印每个工具的名称、用途和参数结构。
            for tool in list_result.tools:
                print(f"- {tool.name}：{tool.description}")
                pprint.pp(tool.inputSchema)

            print_step("4. Host 发起工具调用")

            # Host 根据当前任务决定需要使用哪个工具，
            # 然后让 Client 按照 MCP 协议发起调用。
            print("[Host] 当前任务需要查询订单 A1024")
            print("[Host] 让 Client 调用 get_order")

            # 调用 Server 暴露的 get_order 工具，并传入订单号。
            result = await client.call_tool(
                "get_order",
                {
                    "orderId": "A1024",
                },
            )

            print_step("5. 结果返回 Host")

            # Server 返回的是 JSON 字符串，这里将其解析为 Python 对象。
            order_result = text_content_to_json(result)

            print("[Client] 已收到 Server 返回的执行结果")
            print("[Host] 得到订单数据：")
            pprint.pp(order_result)

    # 无论工具调用成功还是失败，退出 async with 后都会关闭 Client。
    # Client 关闭后，stdio 连接以及由传输层启动的 Server 子进程也会随之结束。
    print("\n[Host] 本次任务结束，关闭 Client 和 Server 连接")


if __name__ == "__main__":
    asyncio.run(main())


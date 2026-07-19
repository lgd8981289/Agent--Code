"""使用 Streamable HTTP 连接高德地图远程 MCP Server。"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Callable, Sequence
from contextlib import AbstractAsyncContextManager
from pprint import pprint
from typing import Any
from urllib.parse import urlencode

from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client

AMAP_MCP_URL = "https://mcp.amap.com/mcp"
DEFAULT_CITY = "北京"


def create_amap_mcp_url(api_key: str | None = None) -> str:
    """使用学生自己的高德 Key 生成远程 MCP 地址。

    Key 只在运行时读取，不写入源码，也不打印到终端。
    测试可以显式传入 ``api_key``，从而不依赖任何环境文件。
    """

    resolved_api_key = api_key
    if resolved_api_key is None:
        resolved_api_key = os.getenv("AMAP_MAPS_API_KEY")

    resolved_api_key = resolved_api_key.strip() if resolved_api_key else ""

    if not resolved_api_key:
        raise RuntimeError(
            "缺少 AMAP_MAPS_API_KEY，请先在 .env 中配置高德 Web 服务 Key。"
        )

    return f"{AMAP_MCP_URL}?{urlencode({'key': resolved_api_key})}"


def print_tools(tools: Sequence[types.Tool]) -> None:
    """打印 Server 暴露的 Tool，帮助观察远程能力发现结果。"""

    print(f"\n发现 {len(tools)} 个 Tool：")

    for index, tool in enumerate(tools, start=1):
        if tool.description is None:
            first_line = "无描述"
        else:
            description_lines = tool.description.strip().split("\n")
            first_line = description_lines[0]
        print(f"{index}. {tool.name}")
        print(f"   {first_line}")


def print_tool_result(result: types.CallToolResult) -> None:
    """打印 MCP Tool 返回的 Content，兼容文本和其他内容类型。"""

    print("\nTool 返回：")

    for content in result.content or []:
        if isinstance(content, types.TextContent):
            print(content.text)
            continue

        # Python SDK 使用 Pydantic 对象表达图片、音频等非文本 Content。
        # 转为普通字典后再打印，便于学生观察完整返回结构。
        if hasattr(content, "model_dump"):
            pprint(content.model_dump(by_alias=True, exclude_none=True))
        else:
            pprint(content)


TransportFactory = Callable[
    [str],
    AbstractAsyncContextManager[tuple[Any, Any, Callable[[], str | None]]],
]


async def run_remote_mcp_client(
    *,
    api_key: str | None = None,
    city: str | None = None,
    transport_factory: TransportFactory = streamable_http_client,
    session_factory: Callable[..., Any] = ClientSession,
) -> None:
    """连接远程 MCP Server，完成能力发现并查询城市天气。"""

    # 读取高德 Key 并创建远程 MCP 地址
    server_url = create_amap_mcp_url(api_key)
    # 显式参数用于离线测试；正常运行时仍从进程环境读取查询城市。
    resolved_city = city
    if resolved_city is None:
        resolved_city = os.getenv("AMAP_TEST_CITY")
    resolved_city = resolved_city.strip() if resolved_city else ""
    resolved_city = resolved_city or DEFAULT_CITY

    print("正在连接高德地图远程 MCP Server...")
    print(f"地址：{AMAP_MCP_URL}?key=***")

    # Python SDK 的 Streamable HTTP 客户端通过异步上下文管理连接生命周期。
    async with transport_factory(server_url) as (
        read_stream,
        write_stream,
        get_session_id,
    ):
        # 创建 MCP Client Session，并保留 Node 示例中的客户端名称和版本。
        async with session_factory(
            read_stream,
            write_stream,
            client_info=types.Implementation(
                name="agent-course-amap-mcp-client",
                version="1.0.0",
            ),
        ) as session:
            # initialize() 对应 Node 版本的 client.connect(transport)。
            initialize_result = await session.initialize()

            print("连接成功")
            print(f"协议版本：{initialize_result.protocolVersion or 'Server 未返回'}")

            session_id = get_session_id()
            session_message = (
                f"Server 分配了 {session_id}"
                if session_id
                else "Server 未分配 Session ID"
            )
            print(f"传输会话：{session_message}")

            tools_result = await session.list_tools()
            print_tools(tools_result.tools)

            # 查找 maps_weather Tool 并调用
            weather_tool = next(
                (tool for tool in tools_result.tools if tool.name == "maps_weather"),
                None,
            )

            if weather_tool is None:
                raise RuntimeError("高德 MCP Server 当前没有返回 maps_weather Tool。")

            print(f"\n调用 Tool：{weather_tool.name}")
            print(f"查询城市：{resolved_city}")

            # 调用远程 MCP Tool
            result = await session.call_tool(
                weather_tool.name,
                arguments={"city": resolved_city},
            )

            print_tool_result(result)


async def main() -> int:
    """运行课程示例，并把用户可理解的错误输出到终端。"""

    try:
        await run_remote_mcp_client()
        return 0
    except Exception as error:  # noqa: BLE001 - 入口需要统一转换 SDK 异常
        message = str(error)

        print("\n高德远程 MCP 调用失败：", file=sys.stderr)

        if "infocode" in message and "Unrecognized keys" in message:
            print(
                "高德 Server 拒绝了当前 Key，请检查 AMAP_MAPS_API_KEY。",
                file=sys.stderr,
            )
        else:
            print(message, file=sys.stderr)

        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

"""验证售后 MCP Server 暴露的能力。"""

from __future__ import annotations

import asyncio
import json
import pprint
import sys
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


server_path = Path(__file__).resolve().with_name("after_sales_mcp_server.py")


def print_title(title: str) -> None:
    print(f"\n================ {title} ================")


def to_plain(value: Any) -> Any:
    """把 MCP SDK 返回对象转换成方便打印的普通 dict。"""

    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True)
    return value


def print_text_result(result: Any) -> None:
    text = next(
        (
            item.text
            for item in getattr(result, "content", [])
            if getattr(item, "type", None) == "text"
        ),
        None,
    )
    print(text if text is not None else result)


async def main() -> None:
    server_params = StdioServerParameters(
        command=sys.executable,
        args=[str(server_path)],
    )

    async with stdio_client(server_params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as client:
            init_result = await client.initialize()

            print_title("1. 查看 Server 能力")
            print("Server:", to_plain(init_result.serverInfo))
            print("Capabilities:", to_plain(init_result.capabilities))

            print_title("2. 查看 Tools")
            tools_result = await client.list_tools()
            for tool in tools_result.tools:
                print(f"- {tool.name}：{tool.description}")

            print_title("3. 调用退款预检 Tool")
            refund_result = await client.call_tool(
                "check_refund_eligibility",
                {
                    "orderId": "A1024",
                },
            )
            print_text_result(refund_result)

            print_title("4. 读取 Resource")
            resources_result = await client.list_resources()
            for resource in resources_result.resources:
                print(f"- {resource.uri}：{resource.description}")

            policy = await client.read_resource("refund-policy://default")
            print(policy.contents[0].text if policy.contents else None)

            print_title("5. 获取 Prompt")
            prompts_result = await client.list_prompts()
            for prompt in prompts_result.prompts:
                print(f"- {prompt.name}：{prompt.description}")

            prompt = await client.get_prompt(
                "refund-review",
                {
                    "orderId": "A1024",
                    "customerQuestion": "3000 元的咖啡机退款，需要人工审核吗？",
                },
            )
            pprint.pp([to_plain(message) for message in prompt.messages])

            print_title("6. 验证未知订单")
            unknown_order = await client.call_tool(
                "get_order",
                {
                    "orderId": "UNKNOWN",
                },
            )
            print_text_result(unknown_order)

    print("\n[Client] 验证结束，关闭连接")


if __name__ == "__main__":
    asyncio.run(main())


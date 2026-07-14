"""订单 MCP Server。"""

from __future__ import annotations

import json
import sys
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from order_system import get_order_by_id


# 创建订单 MCP Server。
#
# name：Server 的唯一名称，Client 可以通过它识别当前 Server。
# Node SDK 的 McpServer 支持 version 字段；Python FastMCP v1.28.1
# 入口构造函数只接收 name 等运行参数，因此这里保留相同的 Server 名称。
# log_level 设置为 ERROR，避免 SDK 内部请求日志混入课程主流程输出。
server = FastMCP(name="order-mcp-server", log_level="ERROR")


@server.tool(
    name="get_order",
    description="根据订单号查询订单信息",
)
async def get_order(
    orderId: Annotated[str, Field(description="订单号，例如 A1024")],
) -> str:
    """当 Client 调用 get_order 时，执行该处理函数。"""

    # stdio 模式下，标准输出 stdout 专门用于传输 MCP 协议消息。
    # 普通日志必须写入标准错误 stderr，否则可能干扰协议通信。
    print(f"[Server] 收到 get_order 调用，orderId={orderId}", file=sys.stderr)

    # 调用真实订单系统，查询对应的订单信息。
    result = await get_order_by_id(orderId)

    # FastMCP 会把字符串返回值封装成 MCP Tool 的 text content。
    # 这里保持 Node 版本行为：将订单查询结果序列化为字符串后返回给 Client。
    return json.dumps(result, ensure_ascii=False)


if __name__ == "__main__":
    print("[Server] 订单 MCP Server 已启动，等待 Client 连接", file=sys.stderr)

    # 创建 stdio 传输层，并将 MCP Server 与 stdio 传输层连接。
    #
    # Client 会启动当前 Server 进程，并通过：
    # - stdin 向 Server 发送 MCP 消息；
    # - stdout 接收 Server 返回的 MCP 消息。
    server.run(transport="stdio")

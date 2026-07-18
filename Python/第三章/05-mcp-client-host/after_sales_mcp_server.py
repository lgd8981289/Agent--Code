"""售后 MCP Server。"""

from __future__ import annotations

import json
import sys
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from order_system import check_refund_eligibility, get_order_by_id
from refund_policy import refund_policy_text, refund_policy_uri


# 创建 MCP Server。
#
# name 用于标识当前 Server，MCP Client 建立连接后可以读取这些基础信息。
# Node SDK 的 McpServer 支持 version 字段；Python FastMCP v1.28.1
# 入口构造函数不接收 version，因此这里保留相同的 Server 名称。
# log_level 设置为 ERROR，避免 SDK 内部请求日志混入课程主流程输出。
server = FastMCP(name="after-sales-capabilities-server", log_level="ERROR")


@server.tool(
    name="get_order",
    title="查询订单",
    description="根据订单号查询订单详情",
)
async def get_order(
    orderId: Annotated[str, Field(description="订单号，例如 A1024")],
) -> str:
    """注册 get_order Tool。"""

    # stdio 模式下，标准输出 stdout 用于传输 MCP 协议消息。
    #
    # 因此调试日志应输出到 stderr，
    # 避免 print 普通输出污染协议通信数据。
    print(f"[Server] get_order orderId={orderId}", file=sys.stderr)

    # 调用 Server 背后的真实订单查询函数。
    result = await get_order_by_id(orderId)

    # MCP Tool 的执行结果通过 content 数组返回。
    # FastMCP 会把字符串返回值封装为 text content。
    return json.dumps(result, ensure_ascii=False, indent=2)


@server.tool(
    name="check_refund_eligibility",
    title="退款预检",
    description="根据订单信息判断是否满足退款条件，以及是否需要人工审核",
)
async def check_refund(
    orderId: Annotated[str, Field(description="订单号，例如 A1024")],
) -> str:
    """注册 check_refund_eligibility Tool。"""

    print(f"[Server] check_refund_eligibility orderId={orderId}", file=sys.stderr)

    # 调用真实业务系统中的退款资格判断函数。
    result = await check_refund_eligibility(orderId)

    return json.dumps(result, ensure_ascii=False, indent=2)


@server.resource(
    refund_policy_uri,
    name="refund-policy",
    title="售后退款规则",
    description="客服和售后 Agent 需要遵守的退款规则",
    mime_type="text/markdown",
)
async def read_refund_policy() -> str:
    """注册 refund-policy Resource。"""

    print(f"[Server] read resource {refund_policy_uri}", file=sys.stderr)
    return refund_policy_text


@server.prompt(
    name="refund-review",
    title="退款审核回复模板",
    description="根据订单信息、退款预检结果和售后政策生成客服回复",
)
def refund_review_prompt(
    orderId: Annotated[str, Field(description="订单号")],
    customerQuestion: Annotated[str, Field(description="用户原始问题")],
) -> dict[str, object]:
    """注册 refund-review Prompt。"""

    print(f"[Server] get prompt refund-review orderId={orderId}", file=sys.stderr)

    # 返回可以交给大模型使用的消息模板。
    #
    # 这里只提供任务要求、订单号和用户问题。
    # 订单查询结果、退款预检结果和退款规则，
    # 仍然需要由 Host 获取后补充进模型上下文。
    return {
        "role": "user",
        "content": {
            "type": "text",
            "text": "\n".join(
                [
                    "你是企业售后客服 Agent。",
                    "请根据订单查询结果、退款预检结果和售后规则回答用户。",
                    "如果资料不足，不要编造。",
                    f"订单号：{orderId}",
                    f"用户问题：{customerQuestion}",
                ]
            ),
        },
    }


if __name__ == "__main__":
    # 使用 stderr 输出启动日志，避免影响 stdio 协议通信。
    print("[Server] 售后 MCP Server 已启动", file=sys.stderr)

    # 将 MCP Server 连接到 stdio 传输层。
    server.run(transport="stdio")


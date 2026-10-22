"""stdout 只输出 MCP 协议数据；所有业务异常通过 isError 返回。"""

import asyncio
import os
from uuid import UUID
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, TextContent, Tool, ListToolsResult
from server.business import Business
from server.common import dumps, require
from server.fixtures import ACCOUNTS
from server.storage import Storage


def create_server(business, actor):
    require(actor and actor["role"] == "customer", "MCP 缺少由宿主设置的客户身份")
    async def list_tools(context, params):
        descriptions = {"list_orders": "查询当前客户自己的订单", "get_order": "根据订单号核对本人订单",
                        "get_logistics": "查询本人订单签收和物流信息", "submit_refund": "执行已批准的申请；金额只从审批记录读取",
                        "get_refund": "核对同一退款请求的实际执行结果"}
        result = []
        for name, description in descriptions.items():
            key = "caseId" if name in ("submit_refund", "get_refund") else "orderId"
            props = {} if name == "list_orders" else {key: {"type": "string", **({"format": "uuid"} if key == "caseId" else {"maxLength": 30})}}
            result.append(Tool(name=name, description=description, input_schema={"type": "object", "properties": props, "required": list(props), "additionalProperties": False}))
        return ListToolsResult(tools=result)

    async def call_tool(context, params):
        try:
            name, arguments = params.name, params.arguments or {}
            expected = set() if name == "list_orders" else {"caseId"} if name in ("submit_refund", "get_refund") else {"orderId"}
            require(set(arguments) == expected, "业务工具参数不符合约定")
            if name == "list_orders":
                value = await business.orders(actor)
            elif name in ("get_order", "get_logistics"):
                id = arguments.get("orderId")
                require(isinstance(id, str) and len(id) <= 30, "订单号无效")
                value = await business.order(actor, id)
                if name == "get_logistics":
                    value = dict(orderId=value["id"], signedAt=value["signedAt"], tracking=value["tracking"], status=value["deliveryStatus"])
            elif name in ("submit_refund", "get_refund"):
                id = str(UUID(arguments["caseId"]))
                value = await (business.refund(actor, id) if name == "submit_refund" else business.lookup(actor, id))
            else:
                raise ValueError("业务工具不存在")
            return CallToolResult(content=[TextContent(type="text", text=dumps(value))])
        except Exception as error:
            return CallToolResult(content=[TextContent(type="text", text=dumps({"error": str(error)}))], is_error=True)

    return Server("aftersales-business", version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool)


async def main():
    actor = next((a for a in ACCOUNTS if a["id"] == os.environ.get("MCP_ACTOR_ID") and a["role"] == "customer"), None)
    require(actor, "MCP 缺少由宿主设置的客户身份")
    db = await Storage().open()
    server = create_server(Business(db), actor)
    try:
        async with stdio_server() as (reader, writer):
            await server.run(reader, writer, server.create_initialization_options())
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())

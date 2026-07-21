"""演示 MCP Elicitation 与 Multi Round-Trip Requests 扩展能力。"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any
from uuid import uuid4

from mcp.server import Server, ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp_types import (
    CallToolRequestParams,
    CallToolResult,
    ElicitRequest,
    ElicitRequestFormParams,
    ElicitResult,
    InputRequiredResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
)

# 模拟后台任务存储。
#
# key：任务 ID，也就是 jobId
# value：任务相关数据，例如订单 ID 和任务创建时间
#
# 真实项目中通常会把任务保存到数据库、Redis
# 或专门的任务队列中，而不是保存在当前进程内存里。
jobs: dict[str, dict[str, Any]] = {}

# Server 请求 Host 收集用户确认信息时使用的 JSON Schema。
#
# Host 可以根据这份 Schema 生成确认框、表单
# 或命令行交互界面。
#
# 用户最终需要返回类似的数据：
#
# {
#   "confirm": true
# }
confirmation_schema = {
    "type": "object",
    "properties": {
        "confirm": {
            "type": "boolean",
            "description": "是否确认启动批量退款审核",
        }
    },
    "required": ["confirm"],
}


def get_job_snapshot(
    job: dict[str, Any],
    *,
    current_time_ms: float | None = None,
) -> dict[str, Any]:
    """根据任务创建时间模拟后台审核进度。

    真实项目通常会从任务队列、数据库或任务调度系统中
    查询当前任务的状态、进度和执行结果。
    """

    # 计算任务已经执行了多长时间
    now_ms = current_time_ms
    if now_ms is None:
        now_ms = time.time() * 1000
    elapsed_ms = now_ms - job["createdAt"]

    # 创建后 1 秒内，模拟正在读取订单信息
    if elapsed_ms < 1000:
        return {
            "status": "working",
            "progress": 30,
            "message": "正在读取订单信息",
        }

    # 创建后 1～2 秒，模拟正在检查退款规则
    if elapsed_ms < 2000:
        return {
            "status": "working",
            "progress": 70,
            "message": "正在检查退款规则",
        }

    # 超过 2 秒后，模拟任务执行完成
    order_ids = job["orderIds"]
    return {
        "status": "completed",
        "progress": 100,
        "message": "审核完成",
        # 模拟批量退款审核结果
        "result": {
            # 本次审核的订单总数
            "total": len(order_ids),
            # 演示规则：
            # A1024 需要进入人工审核
            "manualReview": [
                order_id for order_id in order_ids if order_id == "A1024"
            ],
            # 其他订单自动审核通过
            "autoApproved": [
                order_id for order_id in order_ids if order_id != "A1024"
            ],
        },
    }


def _json_text(data: dict[str, Any]) -> str:
    """生成与 JSON.stringify 一致的紧凑 JSON 文本。"""

    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _validate_order_ids(arguments: dict[str, Any]) -> list[str]:
    """复现 Node 版本中 Zod 对 orderIds 的基础校验。"""

    order_ids = arguments.get("orderIds")
    if (
        not isinstance(order_ids, list)
        or not order_ids
        or any(not isinstance(order_id, str) for order_id in order_ids)
    ):
        raise ValueError("orderIds 必须是至少包含一个字符串的数组")
    return order_ids


def _validate_job_id(arguments: dict[str, Any]) -> str:
    """复现 Node 版本中 Zod 对 jobId 的基础校验。"""

    job_id = arguments.get("jobId")
    if not isinstance(job_id, str):
        raise ValueError("jobId 必须是字符串")
    return job_id


def create_server(
    *,
    job_store: dict[str, dict[str, Any]] | None = None,
    clock: Callable[[], float] | None = None,
    uuid_factory: Callable[[], Any] = uuid4,
) -> Server:
    """创建演示用 MCP Server。

    Server 对外暴露两个 Tool：

    1. start_batch_refund_review
       请求用户确认，并在确认后创建后台审核任务。

    2. get_refund_review_status
       根据 jobId 查询后台任务的执行进度和结果。
    """

    active_jobs = jobs if job_store is None else job_store
    now = clock or (lambda: time.time() * 1000)

    async def list_tools(
        context: ServerRequestContext,
        params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        """向 Client 暴露本节使用的两个 Tool。"""

        del context, params
        return ListToolsResult(
            tools=[
                Tool(
                    name="start_batch_refund_review",
                    description="经用户确认后，创建一项批量退款审核任务",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "orderIds": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 1,
                            }
                        },
                        "required": ["orderIds"],
                    },
                ),
                Tool(
                    name="get_refund_review_status",
                    description="根据任务 ID 查询批量退款审核进度和结果",
                    inputSchema={
                        "type": "object",
                        "properties": {"jobId": {"type": "string"}},
                        "required": ["jobId"],
                    },
                ),
            ]
        )

    async def call_tool(
        context: ServerRequestContext,
        params: CallToolRequestParams,
    ) -> CallToolResult | InputRequiredResult:
        """执行 Tool，并处理多轮输入响应。"""

        del context
        arguments = params.arguments or {}

        if params.name == "start_batch_refund_review":
            # Tool 的业务参数：至少需要传入一个待审核订单 ID。
            # Python v2 低层 Server 不会自动应用 inputSchema，
            # 因此这里显式校验，保持 Node/Zod 版本的输入边界。
            order_ids = _validate_order_ids(arguments)

            # 从当前 MCP 请求的 inputResponses 中，
            # 读取标识为 confirm 的用户输入响应。
            #
            # 第一次调用时通常不存在 inputResponses。
            # 第二次调用时，可能读取到类似的数据：
            #
            # {
            #   "confirm": {
            #     "action": "accept",
            #     "content": {
            #       "confirm": true
            #     }
            #   }
            # }
            response = (params.input_responses or {}).get("confirm")

            # 如果已经存在 Elicitation 响应，
            # 但用户没有选择 accept，则认为用户取消或拒绝了操作。
            #
            # 注意：
            # action != "accept" 表示用户没有提交确认表单，
            # 与 content.confirm == false 是不同的含义。
            if isinstance(response, ElicitResult) and response.action != "accept":
                return CallToolResult(
                    isError=True,
                    content=[TextContent(text="用户取消了批量退款审核")],
                )

            confirmation: dict[str, Any] | None = None
            if isinstance(response, ElicitResult) and response.action == "accept":
                confirmation = response.content
                if (
                    confirmation is None
                    or not isinstance(confirmation.get("confirm"), bool)
                ):
                    raise ValueError("confirm 响应必须包含布尔值")

            # 如果当前还没有拿到用户的明确确认，
            # 就暂不创建后台任务，而是返回 input_required。
            #
            # 本次 Tool 调用会在这里结束。
            # Host 收集完用户答案后，会携带 inputResponses
            # 自动再次调用 start_batch_refund_review。
            if not confirmation or not confirmation["confirm"]:
                return InputRequiredResult(
                    inputRequests={
                        # confirm 是本次输入请求的唯一标识。
                        # Host 后续提交 inputResponses 时，
                        # 也会使用相同的 confirm 作为 key。
                        "confirm": ElicitRequest(
                            params=ElicitRequestFormParams(
                                # Host 展示给用户的提示信息
                                message=(
                                    f"即将审核 {len(order_ids)} 笔退款订单，是否继续？"
                                ),
                                # Host 需要按照这份 JSON Schema 收集用户输入
                                requestedSchema=confirmation_schema,
                            )
                        )
                    }
                )

            # 只有在用户明确提交：
            #
            # {
            #   "confirm": true
            # }
            #
            # 后，才会真正创建后台审核任务。

            # 为后台任务生成唯一 ID
            job_id = str(uuid_factory())

            # 保存任务参数和创建时间
            active_jobs[job_id] = {
                "orderIds": list(order_ids),
                "createdAt": now(),
            }

            # Tool 不等待后台任务执行完成，
            # 而是立即返回 jobId。
            #
            # Host 后续可以调用 get_refund_review_status
            # 轮询任务状态。
            return CallToolResult(
                content=[
                    TextContent(
                        text=_json_text(
                            {
                                "jobId": job_id,
                                "status": "working",
                                "message": "批量退款审核任务已经创建",
                            }
                        )
                    )
                ]
            )

        if params.name == "get_refund_review_status":
            # 查询任务时必须传入任务 ID。
            job_id = _validate_job_id(arguments)

            # 根据 jobId 查找后台任务
            job = active_jobs.get(job_id)

            # 找不到任务时返回 Tool 执行错误
            if job is None:
                return CallToolResult(
                    isError=True,
                    content=[TextContent(text=f"没有找到任务：{job_id}")],
                )

            # 返回当前任务的状态快照。
            #
            # 可能返回：
            # - working：任务仍在执行
            # - completed：任务已经完成
            return CallToolResult(
                content=[
                    TextContent(
                        text=_json_text(
                            {
                                "jobId": job_id,
                                **get_job_snapshot(job, current_time_ms=now()),
                            }
                        )
                    )
                ]
            )

        raise ValueError(f"未知 Tool：{params.name}")

    # 低层 Server 可以精确返回 InputRequiredResult，
    # 因而最贴近 Node 版本 inputRequired() 的教学结构。
    return Server(
        "refund-review-extension-server",
        version="1.0.0",
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


async def main() -> None:
    """创建 MCP Server，并通过 stdio 传输层启动。"""

    server = create_server()

    # MCP Client 可以通过当前进程的 stdin 和 stdout
    # 与这个 MCP Server 交换协议消息。
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    asyncio.run(main())

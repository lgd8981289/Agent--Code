"""MCP 扩展能力 Host：处理用户确认并轮询后台任务。"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from mcp import Client, StdioServerParameters
from mcp.client import ClientRequestContext
from mcp.client.stdio import stdio_client
from mcp_types import (
    CallToolResult,
    ElicitRequestParams,
    ElicitResult,
    Implementation,
    TextContent,
)

# 获取 MCP Server 文件的绝对路径。
#
# 后面创建 stdio 传输层时，
# MCP Client 会通过 Python 子进程启动这个 Server。
server_path = Path(__file__).resolve().with_name("refund_review_mcp_server.py")


def parse_tool_json(result: CallToolResult) -> dict[str, Any]:
    """读取 MCP Tool 返回的第一段文本，并转换成 JSON。

    MCP Tool 的 content 通常是一个内容块数组，例如：

    {
      "content": [
        {
          "type": "text",
          "text": "{\"jobId\":\"xxx\",\"status\":\"working\"}"
        }
      ]
    }

    这个函数会找到第一段 text 内容，
    再通过 json.loads() 转换成 Python 字典。
    """

    block = next(
        (item for item in result.content if isinstance(item, TextContent)),
        None,
    )

    if block is None:
        raise RuntimeError("Tool 没有返回文本结果")

    parsed = json.loads(block.text)
    if not isinstance(parsed, dict):
        raise ValueError("Tool 返回的 JSON 不是对象")
    return parsed


def create_elicitation_handler(
    *,
    auto_confirm: bool,
    question_reader: Callable[[str], str] = input,
) -> Callable[[ClientRequestContext, ElicitRequestParams], Awaitable[ElicitResult]]:
    """创建 Elicitation 请求处理器。"""

    async def handle_elicitation(
        context: ClientRequestContext,
        params: ElicitRequestParams,
    ) -> ElicitResult:
        del context

        # Server 希望展示给用户的提示信息
        message = params.message

        # 使用 --yes 启动时，默认直接确认
        confirmed = auto_confirm

        # 如果没有启用自动确认，
        # 就在终端中询问用户是否继续执行。
        if not auto_confirm:
            # 等待用户输入 y 或 n。
            # input() 是同步函数，因此放到线程中，避免阻塞异步 MCP 会话。
            answer = await asyncio.to_thread(
                question_reader,
                f"{message}（y/n）：",
            )

            # 只有输入 y 时才认为用户确认继续
            confirmed = answer.strip().lower() == "y"

        print(f"Host 收集到的确认结果：{'继续执行' if confirmed else '取消执行'}")

        # 把用户的选择转换成 Elicitation 响应。
        #
        # 用户确认时返回：
        #
        # {
        #   "action": "accept",
        #   "content": {
        #     "confirm": true
        #   }
        # }
        #
        # action="accept" 表示用户接受并提交了本次输入请求。
        # content.confirm=true 表示用户同意启动批量退款审核。
        if confirmed:
            return ElicitResult(
                action="accept",
                content={"confirm": True},
            )

        # decline 表示用户拒绝本次输入请求，
        # 因此不需要再提供 content。
        return ElicitResult(action="decline")

    return handle_elicitation


async def run_host(
    *,
    auto_confirm: bool,
    client_source: Any | None = None,
    question_reader: Callable[[str], str] = input,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, Any] | None:
    """启动 Host 的完整执行流程。

    1. 创建 MCP Client
    2. 连接 MCP Server
    3. 调用批量退款审核 Tool
    4. 在需要时向用户收集确认信息
    5. 获取后台任务 jobId
    6. 轮询任务状态，直到审核完成
    """

    if client_source is None:
        # 创建 stdio 传输层。
        #
        # Client 会启动下面的 MCP Server：
        #
        # python refund_review_mcp_server.py
        #
        # 启动后，Client 与 Server 通过 stdin 和 stdout
        # 交换 MCP 协议消息。
        server = StdioServerParameters(
            # 使用当前 Python 可执行程序启动 Server
            command=sys.executable,
            # Server 文件路径
            args=[str(server_path)],
        )
        client_source = stdio_client(server)

    # 创建 MCP Client。
    #
    # 这里的程序整体属于 Host，
    # client 对象只是 Host 内部负责 MCP 协议通信的组件。
    #
    # MCP Client 本身不负责调用大模型，
    # 也不负责决定什么时候需要执行退款审核。
    async with Client(
        client_source,
        # 当前 Client 的名称和版本
        client_info=Implementation(
            name="refund-review-extension-host",
            version="1.0.0",
        ),
        # 自动与 Server 协商 MCP 协议版本。
        # 这一节会协商到支持 input_required 的 2026-07-28 版本。
        mode="auto",
        # 注册回调也会让 Client 声明 Elicitation 表单能力。
        elicitation_callback=create_elicitation_handler(
            auto_confirm=auto_confirm,
            question_reader=question_reader,
        ),
    ) as client:
        print("\n一、调用 start_batch_refund_review")

        # 调用启动批量退款审核的 Tool。
        #
        # 第一次调用时没有用户确认结果，
        # Server 会返回 input_required，请求 Host 收集确认信息。
        #
        # Python Client 会把请求交给 Elicitation 回调，
        # 再携带 inputResponses 自动重试同一个 Tool。
        start_result = await client.call_tool(
            "start_batch_refund_review",
            {"orderIds": ["A1024", "A1025", "A1026"]},
        )

        # 如果用户拒绝确认，或者 Server 执行失败，
        # Tool 可能返回 isError: true。
        if start_result.is_error:
            error_block = next(
                (
                    item
                    for item in start_result.content
                    if isinstance(item, TextContent)
                ),
                None,
            )

            print(error_block.text if error_block else "批量退款审核没有启动")
            return None

        # 用户确认后，Server 会创建后台任务，
        # 并返回包含 jobId 的 JSON 文本。
        task = parse_tool_json(start_result)

        print("任务创建结果：", task)
        print("\n二、轮询 get_refund_review_status")

        # 持续查询后台任务状态，
        # 直到任务状态变成 completed。
        while True:
            # 每隔 700 毫秒查询一次，避免过于频繁地调用 Tool
            await sleep(0.7)

            # 根据任务创建时返回的 jobId，
            # 调用状态查询 Tool。
            status_result = await client.call_tool(
                "get_refund_review_status",
                {"jobId": task["jobId"]},
            )

            # 把 Tool 返回的 JSON 文本转换成对象
            snapshot = parse_tool_json(status_result)

            # 输出当前任务进度
            print(
                f"[{snapshot['progress']}%] "
                f"{snapshot['status']}：{snapshot['message']}"
            )

            # 任务完成后输出最终结果，
            # 并退出轮询循环。
            if snapshot["status"] == "completed":
                print("最终审核结果：", snapshot["result"])
                return snapshot


async def main() -> None:
    """读取启动参数并运行 Host。"""

    # 如果启动命令包含 --yes，就自动确认，
    # 不再等待用户在终端输入。
    auto_confirm = "--yes" in sys.argv[1:]
    await run_host(auto_confirm=auto_confirm)


if __name__ == "__main__":
    asyncio.run(main())

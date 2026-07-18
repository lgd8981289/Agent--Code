"""使用 MCP Client 与 DeepSeek 实现最小 Host 调用闭环。"""

from __future__ import annotations

import argparse
import asyncio
import json
import pprint
import sys
from pathlib import Path
from typing import Any, Callable

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from deepseek_client import MODEL, call_deepseek


# Host 最多允许模型进行 4 轮工具调用。
#
# 每一轮中，模型可能：
# 1. 返回 tool_calls，要求调用一个或多个工具；
# 2. 不再调用工具，直接返回最终回答。
#
# 设置最大轮次可以防止模型不断调用工具，形成死循环。
MAX_TOOL_ROUNDS = 4

DEFAULT_QUESTION = "订单 A1024 是否满足退款条件？如果可以退款，是否需要人工审核？"

# 获取 MCP Server 脚本的绝对路径。
#
# StdioServerParameters 需要通过 Python 子进程启动这个 Server，
# 因此这里不能只依赖当前命令行所在目录的相对路径。
server_path = Path(__file__).resolve().with_name("after_sales_mcp_server.py")

CallModel = Callable[..., dict[str, Any]]


def print_title(title: str) -> None:
    """打印带有分隔线的步骤标题，方便观察 Host 的完整执行流程。"""

    print(f"\n================ {title} ================")


def to_plain(value: Any) -> Any:
    """把 MCP SDK 返回对象转换成普通 dict，方便打印和 JSON 序列化。"""

    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True)
    return value


def has_capability(capabilities: Any, name: str) -> bool:
    """判断 Server 是否声明支持某个能力类别。"""

    return getattr(capabilities, name, None) is not None


def to_model_tools(mcp_tools: list[Any]) -> list[dict[str, Any]]:
    """把 MCP Server 暴露的 Tool 定义转换成 DeepSeek Tool Calling 格式。

    MCP Tool 的主要结构：

    {
      name,
      description,
      inputSchema
    }

    模型接口要求的主要结构：

    {
      type: 'function',
      function: {
        name,
        description,
        parameters
      }
    }

    MCP 和模型接口都使用 JSON Schema 描述工具参数，
    因此 Host 不需要重新编写参数 Schema，只需要调整外层结构。
    """

    model_tools: list[dict[str, Any]] = []
    for tool in mcp_tools:
        input_schema = dict(getattr(tool, "inputSchema", {}) or {})

        # 部分 MCP Tool 的 inputSchema 中可能包含 $schema 字段，
        # 但模型接口通常只需要 type、properties、required 等内容。
        input_schema.pop("$schema", None)

        model_tools.append(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": input_schema,
                },
            }
        )
    return model_tools


def _normalize_content_block(item: Any) -> Any:
    if hasattr(item, "model_dump"):
        return item.model_dump(by_alias=True, exclude_none=True)
    return item


def to_model_tool_result(result: Any) -> str:
    """把 MCP Tool 的执行结果转换成模型 Tool Message 使用的字符串。

    MCP Tool 返回的是 content blocks：

    {
      content: [
        { type: 'text', text: '...' }
      ]
    }

    模型的 role=tool 消息要求 content 是字符串，因此 Host 需要在这里
    将 MCP 返回结果标准化并序列化。
    """

    content = getattr(result, "content", None) or []

    # 找出所有文本类型的内容块，并使用换行符合并。
    text = "\n".join(
        item.text
        for item in content
        if getattr(item, "type", None) == "text" and getattr(item, "text", None)
    )

    # 按照以下优先级选择实际结果：
    #
    # 1. 文本内容；
    # 2. structuredContent 结构化结果；
    # 3. 原始 content blocks；
    # 4. null。
    structured_content = getattr(result, "structuredContent", None)
    normalized_result: Any = (
        text
        or structured_content
        or [_normalize_content_block(item) for item in content]
        or None
    )

    # 当前售后 MCP Tool 返回的文本通常是 JSON 字符串。
    #
    # 如果能够解析，就恢复成 Python 对象，让模型看到更明确的
    # 字段结构；如果只是普通文本，则直接保留原始内容。
    if text:
        try:
            normalized_result = json.loads(text)
        except json.JSONDecodeError:
            pass

    is_error = bool(getattr(result, "isError", False) or getattr(result, "is_error", False))

    # role=tool 的 content 最终必须是字符串，
    # 所以统一使用 json.dumps 序列化。
    return json.dumps(
        {
            "toolExecutionSucceeded": not is_error,
            "result": normalized_result,
        },
        ensure_ascii=False,
    )


async def execute_mcp_tool(
    client: ClientSession,
    available_tool_names: set[str],
    tool_call: dict[str, Any],
) -> str:
    """执行模型提出的一次工具调用。

    整个调用链为：

    模型返回 tool_call
         ↓
    Host 解析工具名和参数
         ↓
    Host 把调用请求交给 MCP Client
         ↓
    MCP Client 调用 MCP Server
         ↓
    MCP Server 校验参数并执行业务逻辑
    """

    function = tool_call.get("function") or {}
    tool_name = function.get("name")

    # 不直接信任模型返回的工具名。
    #
    # 模型只能调用本次通过 MCP 能力发现获得的工具，
    # 防止模型请求调用不存在或未开放的工具。
    if tool_name not in available_tool_names:
        return json.dumps(
            {
                "ok": False,
                "error": {
                    "code": "MCP_TOOL_NOT_AVAILABLE",
                    "message": f"当前 MCP Server 没有提供工具 {tool_name}",
                },
            },
            ensure_ascii=False,
        )

    # 模型返回的 function.arguments 是 JSON 字符串，
    # Host 需要先将其解析为对象，才能传给 MCP Client。
    try:
        tool_arguments = json.loads(function.get("arguments") or "{}")
    except json.JSONDecodeError:
        return json.dumps(
            {
                "ok": False,
                "error": {
                    "code": "INVALID_TOOL_ARGUMENTS",
                    "message": "模型返回的工具参数不是合法 JSON。",
                },
            },
            ensure_ascii=False,
        )

    try:
        # Client 通过 MCP 协议把工具调用发送给 MCP Server。
        #
        # 真正的参数 Schema 校验和业务逻辑执行都在 Server 中完成，
        # Host 不需要重复实现业务校验。
        result = await client.call_tool(tool_name, tool_arguments)
        return to_model_tool_result(result)
    except Exception as error:
        # 捕获连接失败、协议错误或 Server 执行异常，
        # 并将错误转换成模型能够读取的结构化结果。
        return json.dumps(
            {
                "ok": False,
                "error": {
                    "code": "MCP_TOOL_CALL_FAILED",
                    "message": str(error),
                },
            },
            ensure_ascii=False,
        )


def print_capabilities(
    *,
    server_info: Any,
    capabilities: Any,
    tools: list[Any],
    resources: list[Any],
    prompts: list[Any],
) -> None:
    """打印 MCP Server 已经暴露的能力。"""

    plain_server_info = to_plain(server_info)
    server_name = plain_server_info.get("name") if isinstance(plain_server_info, dict) else None
    server_version = plain_server_info.get("version") if isinstance(plain_server_info, dict) else None
    plain_capabilities = to_plain(capabilities)
    capability_names = (
        list(plain_capabilities.keys())
        if isinstance(plain_capabilities, dict)
        else []
    )

    print(f"Server：{server_name} v{server_version}")
    print(f"能力类别：{'、'.join(capability_names) if capability_names else '无'}")

    print("\nTools：")
    for tool in tools:
        print(f"- {tool.name}：{tool.description}")

    print("\nResources：")
    for resource in resources:
        print(f"- {resource.uri}：{resource.description}")

    print("\nPrompts：")
    for prompt in prompts:
        print(f"- {prompt.name}：{prompt.description}")


async def run_host(
    *,
    user_question: str = DEFAULT_QUESTION,
    discover_only: bool = False,
    call_model: CallModel = call_deepseek,
    max_tool_rounds: int = MAX_TOOL_ROUNDS,
) -> None:
    """执行最小 MCP Host 的完整流程。

    这个 Host 同时管理两类连接：

    1. 通过 MCP Client 连接 MCP Server；
    2. 通过 callDeepSeek 调用大模型。

    Host 的核心职责包括：

    - 创建和管理 MCP Client；
    - 发现 MCP Server 暴露的能力；
    - 把 MCP Tools 转换成模型 Tools；
    - 调用模型；
    - 接收模型返回的 tool_calls；
    - 通过 MCP Client 执行工具；
    - 把工具结果放回 messages；
    - 再次调用模型，直到模型生成最终回答。
    """

    server_params = StdioServerParameters(
        command=sys.executable,
        args=[str(server_path)],
    )

    try:
        print_title("1. MCP Client 连接 Server")

        # 建立 MCP Client 与 MCP Server 之间的连接。
        #
        # 连接过程中双方会完成初始化和能力协商。
        async with stdio_client(server_params) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as client:
                init_result = await client.initialize()

                # 读取 Server 在初始化阶段声明的能力类别。
                capabilities = init_result.capabilities

                # 只有 Server 声明支持对应能力时，才发送具体的列表请求。
                #
                # 这样可以避免向不支持该能力的 Server 发送无效请求。
                tools = (
                    (await client.list_tools()).tools
                    if has_capability(capabilities, "tools")
                    else []
                )
                resources = (
                    (await client.list_resources()).resources
                    if has_capability(capabilities, "resources")
                    else []
                )
                prompts = (
                    (await client.list_prompts()).prompts
                    if has_capability(capabilities, "prompts")
                    else []
                )

                print_capabilities(
                    server_info=init_result.serverInfo,
                    capabilities=capabilities,
                    tools=tools,
                    resources=resources,
                    prompts=prompts,
                )

                print_title("2. MCP Tools 转成模型 Tools")

                # MCP Server 返回的 Tool 结构不能直接提交给 DeepSeek，
                # Host 需要先转换成模型 Tool Calling 接口要求的格式。
                model_tools = to_model_tools(tools)

                for tool in model_tools:
                    print(f"- {tool['function']['name']}")
                    pprint.pp(tool["function"]["parameters"])

                # --discover 模式只验证 MCP 能力发现，
                # 到这里就结束，不进入模型调用流程。
                if discover_only:
                    print("\n能力发现验证结束，本次没有调用模型。")
                    return

                # 没有 Tools 时，模型无法通过 Tool Calling 调用 MCP Server，
                # 因此直接终止当前 Host 流程。
                if len(model_tools) == 0:
                    raise RuntimeError("当前 MCP Server 没有可交给模型使用的 Tools。")

                # 保存本次能力发现得到的工具名。
                #
                # 后续执行模型 tool_call 时，用它检查模型请求的工具
                # 是否确实由当前 MCP Server 提供。
                available_tool_names = {tool.name for tool in tools}

                # 初始化模型上下文。
                #
                # 后续每次模型返回 tool_calls，以及每次 MCP Tool 返回结果，
                # 都会继续追加到这个 messages 数组中。
                messages: list[dict[str, Any]] = [
                    {
                        "role": "system",
                        "content": (
                            "你是星河零售的售后助手。订单信息和退款判断必须以工具结果为准，"
                            "不能自行编造。工具失败时请直接说明失败原因。"
                        ),
                    },
                    {
                        "role": "user",
                        "content": user_question,
                    },
                ]

                print_title("3. Host 开始处理用户问题")
                print(f"模型：{MODEL}")
                print(f"用户：{user_question}")

                # 开始执行 Tool Calling 循环。
                #
                # 每一轮都会调用一次模型：
                #
                # - 模型返回 tool_calls：执行工具并进入下一轮；
                # - 模型不返回 tool_calls：说明已经生成最终回答，结束循环。
                for round_number in range(1, max_tool_rounds + 1):
                    print(f"\n--- 第 {round_number} 轮模型调用 ---")

                    # Host 将当前完整 messages 和可用工具定义交给模型。
                    #
                    # 模型只能提出工具调用请求，不会直接执行 MCP Tool。
                    model_result = call_model(messages=messages, tools=model_tools)
                    tool_calls = model_result["message"].get("tool_calls") or []

                    print(f"finish_reason：{model_result.get('finishReason')}")
                    print(f"耗时：{model_result.get('latencyMs')}ms")

                    # 模型没有返回 tool_calls，表示当前已经不需要继续使用工具，
                    # message.content 就是最终回答。
                    if len(tool_calls) == 0:
                        print("\n最终回答：")
                        print(model_result["message"].get("content"))
                        return

                    # 先把模型返回的 assistant 消息完整加入上下文。
                    #
                    # tool_calls 必须保留下来，因为后续的 role=tool 消息
                    # 需要通过 tool_call_id 与这次调用建立对应关系。
                    messages.append(
                        {
                            "role": "assistant",
                            "content": model_result["message"].get("content"),
                            "tool_calls": tool_calls,
                        }
                    )

                    # 一次模型响应可能同时包含多个 tool_call，
                    # Host 依次执行每一个工具调用。
                    for tool_call in tool_calls:
                        function = tool_call.get("function") or {}
                        print("\n模型提出工具调用：")
                        print(f"- 工具：{function.get('name')}")
                        print(f"- 参数：{function.get('arguments')}")

                        # Host 把模型生成的工具名和参数交给 MCP Client。
                        #
                        # MCP Client 再通过 MCP 协议请求 MCP Server 执行工具。
                        tool_result = await execute_mcp_tool(
                            client,
                            available_tool_names,
                            tool_call,
                        )

                        print("MCP Tool 返回：")
                        print(tool_result)

                        # 把工具执行结果作为 role=tool 消息追加到上下文。
                        #
                        # 下一轮调用模型时，模型就可以读取这次真实工具结果，
                        # 判断是否还需要继续调用其他工具，或者生成最终答案。
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.get("id"),
                                "content": tool_result,
                            }
                        )

                # 达到最大轮次后模型仍然没有生成最终回答，
                # Host 主动终止，避免进入无限工具调用循环。
                raise RuntimeError(f"已经达到最大工具调用轮次 {max_tool_rounds}，Host 主动停止。")
    finally:
        print("\n[Host] MCP Client 已关闭")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--discover", action="store_true", help="只验证 MCP 能力发现")
    parser.add_argument("question", nargs="*", help="用户售后问题")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    question = " ".join(args.question).strip() or DEFAULT_QUESTION

    try:
        asyncio.run(
            run_host(
                user_question=question,
                discover_only=args.discover,
            )
        )
    except Exception as error:
        print(f"\n运行失败： {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


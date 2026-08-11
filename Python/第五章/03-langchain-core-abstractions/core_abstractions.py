import json
import os
import sys
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableLambda, RunnableSequence
from langchain_core.tools import tool
from pydantic import BaseModel, Field


"""
LangChain 核心抽象实验。

本节分别演示：
- Chat Model：把一组 Message 交给模型，得到 AIMessage；
- Message：观察 SystemMessage、HumanMessage、ToolMessage 的职责；
- Tool：把普通函数包装成模型可理解、可校验的工具；
- 手动 Tool Calling：不用 create_agent，自己完成一次工具调用循环；
- RunnableSequence：把固定步骤串成一条可复用的执行流水线。
"""


# 模拟研发任务数据。
# get_task Tool 会根据 taskId 从这里查询任务信息。
TASKS = {
    "DEV-1024": {
        "taskId": "DEV-1024",
        "title": "为任务列表增加 priority 筛选",
        "status": "in_progress",
        "owner": "小明",
        "dueDate": "2026-08-12",
    },
    "DEV-2048": {
        "taskId": "DEV-2048",
        "title": "修复逾期任务边界判断",
        "status": "waiting_for_test",
        "owner": "小李",
        "dueDate": "2026-08-15",
    },
}


class TaskInput(BaseModel):
    """get_task Tool 的输入 Schema。

    这里特意保留 taskId 这个字段名，而不是改成 Python 常见的 task_id。
    原因是模型生成 Tool Call 时看到的参数字段应该和 Node 版本一致。
    """

    taskId: str = Field(
        pattern=r"^DEV-\d+$",
        description="研发任务编号，例如 DEV-1024",
    )


def create_model():
    """创建本章统一使用的 DeepSeek Chat Model。"""

    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先加载你已有的 .env。")

    try:
        from langchain_deepseek import ChatDeepSeek
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langchain-deepseek 依赖，请先执行：python -m pip install -e ."
        ) from exc

    return ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
        max_retries=2,
    )


def message_text(message: Any) -> str:
    """把 Message 的文本内容整理成适合终端打印的字符串。

    普通文本 Message 的 content 通常是 str，
    多模态等场景下也可能是结构化数据。
    """

    content = getattr(message, "content", message)

    if isinstance(content, str):
        return content

    text = getattr(message, "text", None)
    if callable(text):
        value = text()
        if value:
            return value

    return json.dumps(content, ensure_ascii=False, indent=2)


@tool(
    "get_task",
    description="根据研发任务编号查询任务标题、状态、负责人和截止时间",
    args_schema=TaskInput,
)
def get_task(taskId: str) -> str:
    """根据任务编号查询研发任务。"""

    task = TASKS.get(taskId)

    if not task:
        return json.dumps(
            {
                "found": False,
                "taskId": taskId,
                "message": "没有找到对应的研发任务",
            },
            ensure_ascii=False,
        )

    return json.dumps(
        {
            "found": True,
            **task,
        },
        ensure_ascii=False,
    )


def run_model_demo() -> None:
    """演示最基础的 Chat Model 调用。

    输入是一组 Message，
    invoke() 返回模型生成的 AIMessage。
    """

    model = create_model()

    messages = [
        SystemMessage(content="你是研发任务助手，回答必须简洁。"),
        HumanMessage(content="用一句话说明：为什么测试通过以后还要运行类型检查？"),
    ]

    # 将完整消息上下文提交给模型，等待模型一次性生成结果。
    response = model.invoke(messages)

    print("输入 Message：")
    print([message.__class__.__name__ for message in messages])

    print("\n模型返回类型：", response.__class__.__name__)
    print("回答内容：", message_text(response))

    # usage_metadata 中通常包含输入、输出以及总 Token 消耗。
    print("Token 统计：", getattr(response, "usage_metadata", None))


def run_stream_demo() -> None:
    """演示 Chat Model 的流式输出。

    与 invoke() 一次返回完整 AIMessage 不同，
    stream() 会不断返回 AIMessageChunk。
    """

    model = create_model()

    stream = model.stream(
        [
            SystemMessage(content="你是研发任务助手，回答必须简洁。"),
            HumanMessage(content="用两句话解释单元测试和类型检查的区别。"),
        ]
    )

    print("开始接收 AIMessageChunk：\n")

    # 持续读取模型返回的消息片段并立即打印。
    for chunk in stream:
        sys.stdout.write(message_text(chunk))
        sys.stdout.flush()

    sys.stdout.write("\n")


def run_tool_demo() -> None:
    """演示直接调用 Tool。

    这里没有大模型参与，
    本质上就是应用代码主动执行 get_task。

    可以借此观察：
    1. Pydantic Schema 的参数校验；
    2. Tool 函数真正返回的结果。
    """

    print("Tool 名称：", get_task.name)
    print("Tool 描述：", get_task.description)

    # 参数满足 Schema，正常执行 Tool。
    result = get_task.invoke({"taskId": "DEV-1024"})

    print("\n正确参数的执行结果：")
    print(json.loads(result))

    print("\n错误参数的执行结果：")

    try:
        # 不满足 /^DEV-\d+$/，会在执行 Tool 函数前被 Schema 拦截。
        get_task.invoke({"taskId": "1024"})
    except Exception as error:
        print(error)


def _first_tool_call(decision: Any) -> dict[str, Any]:
    """从模型返回的 AIMessage 中取出第一个 Tool Call。"""

    tool_calls = getattr(decision, "tool_calls", None) or []
    tool_call = tool_calls[0] if tool_calls else None

    if not isinstance(tool_call, dict):
        raise RuntimeError("模型没有生成 get_task Tool Call。")

    if not tool_call.get("id"):
        raise RuntimeError("模型没有生成带 ID 的 get_task Tool Call。")

    return tool_call


def run_manual_tool_calling_demo() -> None:
    """不使用 create_agent，手动实现一次完整的 Tool Calling 循环。

    核心流程：

    用户问题
    → 模型决定调用哪个 Tool
    → 应用执行 Tool
    → ToolMessage 回传结果
    → 模型根据结果生成最终回答
    """

    # bind_tools() 把 get_task 的名称、描述和 Schema
    # 提供给模型，使模型获得提出 Tool Call 的能力。
    #
    # 注意：
    # bind_tools() 并不会自动执行 Tool。
    model_with_tools = create_model().bind_tools([get_task])

    messages = [
        SystemMessage(content="你是研发任务助手。查询任务信息时必须调用 get_task，不能猜测。"),
        HumanMessage(content="查询 DEV-1024 当前的状态、负责人和截止时间。"),
    ]

    # 第一次调用模型。
    #
    # 此时模型不是直接查询 TASKS，
    # 而是根据问题判断是否需要调用 get_task。
    decision = model_with_tools.invoke(messages)

    # 本例只处理模型提出的第一个 Tool Call。
    tool_call = _first_tool_call(decision)

    print("模型提出的 Tool Call：")
    print(
        {
            "name": tool_call["name"],
            "args": tool_call["args"],
            "id": tool_call["id"],
        }
    )

    # 模型只负责“提出” Tool Call，
    # 真正执行 get_task 的仍然是应用程序。
    tool_result = get_task.invoke(tool_call["args"])

    # 把 Tool 执行结果包装成 ToolMessage。
    #
    # tool_call_id 必须对应模型刚才提出的 Tool Call ID，
    # 这样模型才能知道这个结果属于哪一次工具调用。
    tool_message = ToolMessage(
        content=tool_result,
        tool_call_id=tool_call["id"],
        name=tool_call["name"],
    )

    print("\nToolMessage：")
    print(
        {
            "name": tool_message.name,
            "tool_call_id": tool_message.tool_call_id,
            "content": json.loads(tool_result),
        }
    )

    # 第二次调用模型。
    #
    # 上下文中同时加入：
    # - 原始 System / Human Message
    # - 模型刚才产生的 Tool Call
    # - Tool 返回的 ToolMessage
    #
    # 模型因此可以基于真实 Tool 数据生成最终答案。
    final_response = model_with_tools.invoke([*messages, decision, tool_message])

    print("\n模型最终回答：")
    print(message_text(final_response))


def task_json_to_messages(task_json: str):
    """把 Tool 返回的任务 JSON 转换成模型需要的 Message。"""

    return [
        SystemMessage(content="你是研发任务助手。请根据给定数据生成一句任务进度摘要。"),
        HumanMessage(content=f"任务数据：{task_json}"),
    ]


def build_task_summary_runnable(model: Any | None = None) -> RunnableSequence:
    """使用 RunnableSequence 组合一条固定执行顺序的流水线。

    与 Agent 不同：
    RunnableSequence 中每一步的执行顺序都是开发者提前定义好的，
    模型不会动态决定下一步执行什么。
    """

    chat_model = model or create_model()

    return (
        # 第一步：
        # 从整个输入中取出 taskId。
        #
        # 输入：
        # { "taskId": "DEV-2048" }
        #
        # 输出：
        # { "taskId": "DEV-2048" }
        RunnableLambda(lambda data: {"taskId": data["taskId"]})
        # 第二步：
        # 调用 get_task Tool 查询任务详情。
        #
        # 上一步的输出会自动成为这一步的输入。
        | get_task
        # 第三步：
        # 把 Tool 返回的任务 JSON 转换成模型需要的 Message。
        | RunnableLambda(task_json_to_messages)
        # 第四步：
        # 把 Message 提交给大模型生成摘要。
        | chat_model
        # 第五步：
        # 从 AIMessage 中提取最终文本。
        | RunnableLambda(message_text)
    )


def run_runnable_demo() -> None:
    """启动整条 RunnableSequence。"""

    task_summary = build_task_summary_runnable()

    # 数据会依次经过：
    #
    # taskId
    # → get_task
    # → Message
    # → Chat Model
    # → string
    result = task_summary.invoke({"taskId": "DEV-2048"})

    print("RunnableSequence 执行结果：")
    print(result)


def main() -> None:
    """根据命令行参数决定运行哪个 Demo。"""

    command = sys.argv[1] if len(sys.argv) > 1 else None

    commands = {
        "model": run_model_demo,
        "stream": run_stream_demo,
        "tool": run_tool_demo,
        "calling": run_manual_tool_calling_demo,
        "runnable": run_runnable_demo,
    }

    if command not in commands:
        print("可用命令：model、stream、tool、calling、runnable")
        raise SystemExit(1)

    # 执行当前命令对应的示例。
    commands[command]()


if __name__ == "__main__":
    main()


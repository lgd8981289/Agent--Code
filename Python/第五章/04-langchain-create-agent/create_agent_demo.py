import json
import os
import sys
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel, Field


"""
create_agent Runtime 多轮执行案例。

这个案例让 Agent 分别查询研发任务和最新测试报告，
再根据两份数据判断任务是否存在延期风险。

第二个 Tool 所需的 repository 来自第一个 Tool，
因此 Agent 必须经历多轮“模型决策 → Tool 执行 → 结果回传”才能完成任务。
"""


# 模拟研发任务系统中的任务数据。
TASKS = {
    "DEV-1024": {
        "taskId": "DEV-1024",
        "title": "为任务列表增加 priority 筛选",
        "status": "in_progress",
        "owner": "小明",
        "dueDate": "2026-08-15",
        "repository": "task-service",
    }
}


# 模拟 CI / 测试平台生成的最新测试报告。
#
# repository 是任务系统与测试系统之间的关联字段：
# Agent 需要先查询任务，拿到 repository，
# 才能继续查询对应仓库的测试结果。
TEST_REPORTS = {
    "task-service": {
        "repository": "task-service",
        "branch": "feature/priority-filter",
        "passed": 31,
        "failed": 2,
        "failures": [
            "priority 参数为空时，没有使用默认值",
            "priority=high 时返回了 medium 任务",
        ],
        "generatedAt": "2026-08-12 09:30:00",
    }
}


QUESTION = "分析研发任务 DEV-1024 是否存在延期风险，并给出处理建议。"


SYSTEM_PROMPT = """你是研发任务交付风险分析 Agent。

分析任务是否能够按期交付时，必须遵守下面的流程：

1. 先调用 get_task 查询任务状态、截止时间和 repository。
2. 再使用 get_task 返回的 repository 调用 get_latest_test_report。
3. 只有同时拿到任务详情和测试报告，才能给出交付风险结论。
4. 只能根据 Tool 返回的数据回答，不得补充不存在的信息。

最终回答需要包含：风险等级、判断依据和处理建议。"""


class TaskInput(BaseModel):
    """get_task 的输入 Schema。

    这里保留 taskId 参数名，使 Python Tool Schema 与 Node 版本一致。
    """

    taskId: str = Field(
        pattern=r"^DEV-\d+$",
        description="研发任务编号，例如 DEV-1024",
    )


class TestReportInput(BaseModel):
    """get_latest_test_report 的输入 Schema。"""

    repository: str = Field(
        min_length=1,
        description="代码仓库名称，必须来自 get_task 返回的 repository",
    )


def create_model():
    """创建本节统一使用的 DeepSeek Chat Model。"""

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


def write_custom_progress(payload: dict[str, str]) -> None:
    """向 Agent Stream 写入自定义进度事件。

    Python 版本通过 langgraph.config.get_stream_writer() 获取 writer。
    当 Tool 被离线测试或普通代码直接调用时，当前上下文可能没有 writer，
    这时忽略即可，不影响 Tool 的最终返回值。
    """

    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
    except Exception:
        return

    writer(payload)


@tool(
    "get_task",
    description="根据研发任务编号查询任务详情。返回的 repository 可用于继续查询该任务所在仓库的测试报告。",
    args_schema=TaskInput,
)
def get_task(taskId: str) -> str:
    """根据任务编号查询研发任务。"""

    # 向外部发送 Tool 执行进度，不会作为 Tool 最终结果返回给模型。
    write_custom_progress(
        {
            "type": "tool_progress",
            "message": f"正在从任务系统读取 {taskId}",
        }
    )

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


@tool(
    "get_latest_test_report",
    description="根据代码仓库名称查询该仓库最新一次自动化测试报告",
    args_schema=TestReportInput,
)
def get_latest_test_report(repository: str) -> str:
    """根据代码仓库名称查询最新一次自动化测试报告。

    repository 不应该由模型凭空生成，
    而应该来自 get_task 返回的任务数据。
    """

    # 将当前 Tool 的执行阶段通过 custom stream 暴露出去。
    write_custom_progress(
        {
            "type": "tool_progress",
            "message": f"正在读取 {repository} 的最新测试报告",
        }
    )

    report = TEST_REPORTS.get(repository)

    if not report:
        return json.dumps(
            {
                "found": False,
                "repository": repository,
                "message": "没有找到对应仓库的测试报告",
            },
            ensure_ascii=False,
        )

    return json.dumps(
        {
            "found": True,
            **report,
        },
        ensure_ascii=False,
    )


def create_delivery_risk_agent(model: Any | None = None):
    """创建研发任务交付风险分析 Agent。

    本例存在明确的数据依赖：

    get_task
       ↓ repository
    get_latest_test_report

    第二次 Tool 调用所需的 repository，
    只有第一次 Tool 执行完成之后才能得到。

    因此整个 Agent Run 会经历多轮：

    Model → Tool → Model → Tool → Model → Final Answer
    """

    try:
        from langchain.agents import create_agent
    except ImportError as exc:
        raise RuntimeError("缺少 langchain 依赖，请先执行：python -m pip install -e .") from exc

    return create_agent(
        model=model or create_model(),
        tools=[get_task, get_latest_test_report],
        system_prompt=SYSTEM_PROMPT,
    )


def message_text(message: Any) -> str:
    """从 Message 或流式 MessageChunk 中提取文本内容。

    完整 Message 的 content 通常直接是字符串，
    流式消息则可以通过 text() 获取当前文本片段。
    """

    content = getattr(message, "content", message)

    if isinstance(content, str):
        return content

    text = getattr(message, "text", None)
    if callable(text):
        return text()

    return ""


def parse_tool_result(message: Any) -> Any:
    """尝试把 Tool 返回的 JSON 字符串恢复成 Python 对象。

    ToolMessage 本质上仍然携带文本内容，
    转成对象以后更方便在控制台观察返回的数据结构。
    """

    content = message_text(message)

    try:
        return json.loads(content)
    except Exception:
        return content


def is_ai_message_like(message: Any) -> bool:
    """判断当前消息是不是模型生成的消息。

    updates 模式通常可能得到完整 AIMessage，
    messages 流式模式下则主要得到 AIMessageChunk。
    """

    return isinstance(message, (AIMessage, AIMessageChunk))


def handle_update(update: dict[str, Any], trajectory: list[Any]) -> list[str]:
    """处理 updates 模式返回的状态增量。

    updates 关注的是：

    “Agent Runtime 的某个节点，本轮向 State 新增了什么？”

    这里把新增 Message 保存到 trajectory，
    同时返回模型 Tool Call、Tool 执行完成以及最终回答等关键节点的日志。
    """

    logs: list[str] = []

    for node_name, state_update in update.items():
        for message in state_update.get("messages", []):
            # 保存本轮新增 Message，后续统一打印完整执行轨迹。
            trajectory.append(message)

            # AIMessage 中存在 tool_calls，
            # 说明模型当前没有直接回答，而是决定调用 Tool。
            if is_ai_message_like(message) and getattr(message, "tool_calls", None):
                for call in message.tool_calls:
                    logs.append(
                        f"[updates/{node_name}] 模型请求调用 {call['name']}({json.dumps(call['args'], ensure_ascii=False)})"
                    )
                continue

            # ToolMessage 表示 Tool 已经执行完成，
            # Tool 返回的数据也已经重新写入 Agent State，
            # 下一轮模型调用可以读取这份 Observation。
            if isinstance(message, ToolMessage):
                logs.append(
                    f"[updates/{node_name}] {message.name} 执行完成，结果已写回 Agent State"
                )
                continue

            # 模型返回 AIMessage，但没有继续产生 Tool Call，
            # 通常意味着模型已经拿到足够信息并生成最终答案。
            if is_ai_message_like(message):
                logs.append(f"[updates/{node_name}] 模型没有继续调用 Tool，本次运行结束")

    return logs


def format_trajectory(trajectory: list[Any], question: str = QUESTION) -> list[str]:
    """按时间顺序格式化一次 Agent Run 的 Message 轨迹。

    可以直观看到：

    HumanMessage
    → AIMessage(Tool Call)
    → ToolMessage
    → AIMessage(Tool Call)
    → ToolMessage
    → AIMessage(Final Answer)
    """

    lines = ["\n\n========== 最终 Message 轨迹 ==========", f"01. HumanMessage：{question}"]

    for index, message in enumerate(trajectory, start=2):
        number = str(index).zfill(2)

        # 模型决定调用一个或多个 Tool。
        if is_ai_message_like(message) and getattr(message, "tool_calls", None):
            calls = "、".join(
                f"{call['name']}({json.dumps(call['args'], ensure_ascii=False)})"
                for call in message.tool_calls
            )
            lines.append(f"{number}. AIMessage：{calls}")
            continue

        # Tool 执行结果作为 ToolMessage 回写到上下文。
        if isinstance(message, ToolMessage):
            lines.append(f"{number}. ToolMessage：{message.name}")
            lines.append(json.dumps(parse_tool_result(message), ensure_ascii=False, indent=2))
            continue

        # 不包含 Tool Call 的 AIMessage，即最终自然语言回答。
        if is_ai_message_like(message):
            lines.append(f"{number}. AIMessage：最终回答")

    return lines


def run_demo() -> None:
    """执行一次完整的 Agent Run。

    本例同时订阅三种流：

    updates：
      观察 Agent Runtime 各节点对 State 的增量更新。

    messages：
      观察模型生成 Token / MessageChunk 的流式输出。

    custom：
      接收 Tool 内通过 stream writer 主动发送的自定义进度事件。

    三种 Stream 观察的是同一次 Agent Run，
    只是观察维度不同。
    """

    agent = create_delivery_risk_agent()

    input_data = {
        "messages": [
            {
                "role": "user",
                "content": QUESTION,
            }
        ]
    }

    trajectory: list[Any] = []

    # 已经执行完成的 Tool 数量。
    completed_tools = 0

    # 标记最终回答是否已经开始输出。
    answer_started = False

    print(f"用户问题：{QUESTION}\n")
    print("========== Agent Runtime 开始执行 ==========")

    stream = agent.stream(input_data, stream_mode=["updates", "messages", "custom"])

    for mode, chunk in stream:
        # updates：观察 Runtime 状态变化。
        if mode == "updates":
            if answer_started:
                sys.stdout.write("\n")

            for line in handle_update(chunk, trajectory):
                print(line)

            # 根据轨迹中的 ToolMessage 数量判断已经完成了几次 Tool 调用。
            completed_tools = sum(isinstance(message, ToolMessage) for message in trajectory)
            continue

        # custom：接收 Tool 通过 stream writer 发出的执行进度。
        if mode == "custom":
            print(f"[custom] {chunk.get('message', chunk)}")
            continue

        # messages：接收模型实时生成的 MessageChunk。
        #
        # 前两轮模型主要生成 Tool Call，
        # 并不是面向用户的最终自然语言回答。
        #
        # 因此这里等待两个 Tool 都执行完成以后，
        # 才开始把模型最终回答实时输出到终端。
        if mode == "messages":
            message_chunk = chunk[0] if isinstance(chunk, tuple) else chunk

            if not isinstance(message_chunk, AIMessageChunk) or completed_tools < 2:
                continue

            text = message_text(message_chunk)

            if not text:
                continue

            if not answer_started:
                answer_started = True
                sys.stdout.write("\n[messages] 模型最终回答：\n")

            # 逐 Chunk 输出，实现最终答案的打字机式流式效果。
            sys.stdout.write(text)
            sys.stdout.flush()

    # Agent Run 完成后，再统一输出完整 Message 执行轨迹。
    for line in format_trajectory(trajectory):
        print(line)


if __name__ == "__main__":
    run_demo()


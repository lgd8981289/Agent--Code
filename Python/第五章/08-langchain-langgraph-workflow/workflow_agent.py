"""
使用 LangGraph 组织确定性业务流程，并在风险分析节点中调用 LangChain Agent。

这个案例把两个层次拆开：

- 外层 Workflow：负责查询任务、分支路由、跳过不需要模型的场景；
- 内层 Agent：只在任务需要分析时进入，负责 Tool Calling 和结构化风险结论。

这样可以避免把所有控制权都交给 Agent：
确定性的业务规则由 Graph 明确表达，
需要模型判断和工具协作的部分再交给 Agent。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Annotated, Any, Literal, NotRequired, TypedDict

from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field


"""
模拟研发任务系统。

DEV-1024 需要继续分析交付风险；
DEV-2048 已经完成，不应该继续消耗模型调用。
"""
TASKS = {
    "DEV-1024": {
        "taskId": "DEV-1024",
        "title": "为任务列表增加 priority 筛选",
        "status": "in_progress",
        "owner": "小明",
        "dueDate": "2026-08-20",
        "repository": "task-service",
    },
    "DEV-2048": {
        "taskId": "DEV-2048",
        "title": "修复导出文件名称乱码问题",
        "status": "completed",
        "owner": "小李",
        "dueDate": "2026-08-12",
        "repository": "export-service",
    },
}


TEST_REPORTS = {
    "task-service": {
        "repository": "task-service",
        "passed": 31,
        "failed": 2,
        "failures": [
            "priority 参数为空时，没有使用默认值",
            "priority=high 时返回了 medium 任务",
        ],
    }
}


FAILURE_DETAILS = {
    "task-service": {
        "repository": "task-service",
        "errorType": "AssertionError",
        "location": "src/tasks/task.service.spec.ts:84",
        "actual": "medium",
        "expected": "high",
    }
}


class RepositoryInput(BaseModel):
    repository: str = Field(description="研发任务所属的代码仓库")


class TaskSchema(BaseModel):
    taskId: str
    title: str
    status: Literal["in_progress", "completed"]
    owner: str
    dueDate: str
    repository: str


class RiskAnalysisSchema(BaseModel):
    taskId: str
    riskLevel: Literal["low", "medium", "high"]
    summary: str
    evidence: list[str] = Field(min_length=2)
    suggestions: list[str] = Field(min_length=1)


class WorkflowResultSchema(BaseModel):
    status: Literal["blocked", "review", "completed", "missing"]
    summary: str
    nextAction: str


def append_execution_path(
    current: list[str] | None,
    node_name: str | list[str] | None,
) -> list[str]:
    """把每个 Node 写入的节点名称追加到执行路径中。

    Node 版使用 ReducedValue，
    让每个 Node 只返回一个字符串，
    reducer 负责把字符串追加到数组里。

    Python LangGraph 通过 Annotated 字段声明 reducer。
    这里同样允许 Node 返回单个节点名称，
    从而保持课程讲解语义一致。
    """

    current_path = current or []

    if node_name is None:
        return current_path

    if isinstance(node_name, list):
        return [*current_path, *node_name]

    return [*current_path, node_name]


class DeliveryWorkflowState(TypedDict, total=False):
    """外层 Workflow 使用的业务 State。

    这里不保存 Agent 的完整 messages，
    只保存业务流程真正需要的数据。
    """

    # 当前要分析的研发任务编号。
    taskId: str

    # load_task 查询到的任务详情。
    task: NotRequired[dict[str, Any] | None]

    # 内层 Agent 生成的结构化风险分析结果。
    riskAnalysis: NotRequired[dict[str, Any] | None]

    # 内层 Agent 实际调用过的业务 Tool 路径。
    agentToolPath: NotRequired[list[str]]

    # 外层 Workflow 最终生成的业务处理结果。
    result: NotRequired[dict[str, Any] | None]

    # 外层 Workflow 实际经过的节点路径。
    executionPath: Annotated[list[str], append_execution_path]


@tool(
    "get_latest_test_report",
    description="查询指定代码仓库的最新自动化测试报告",
    args_schema=RepositoryInput,
)
def get_latest_test_report(repository: str) -> str:
    """查询最新测试报告。"""

    print(f"[Tool] get_latest_test_report：{repository}")
    report = TEST_REPORTS.get(repository)

    return json.dumps(
        report
        or {
            "repository": repository,
            "found": False,
            "message": "没有找到对应仓库的测试报告",
        },
        ensure_ascii=False,
    )


@tool(
    "get_failure_detail",
    description="查询失败测试的断言、文件位置、实际值与期望值",
    args_schema=RepositoryInput,
)
def get_failure_detail(repository: str) -> str:
    """测试失败时，进一步查询失败位置和断言差异。"""

    print(f"[Tool] get_failure_detail：{repository}")
    detail = FAILURE_DETAILS.get(repository)

    return json.dumps(
        detail
        or {
            "repository": repository,
            "found": False,
            "message": "没有找到失败测试详情",
        },
        ensure_ascii=False,
    )


def create_model():
    """创建本示例统一使用的 DeepSeek Chat Model。"""

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
        model_kwargs={
            "thinking": {"type": "disabled"},
        },
    )


_risk_agent: Any | None = None


def create_risk_agent(model: Any | None = None):
    """创建内层风险分析 Agent。"""

    try:
        from langchain.agents import create_agent
        from langchain.agents.structured_output import ToolStrategy
    except ImportError as exc:
        raise RuntimeError("缺少 langchain 依赖，请先执行：python -m pip install -e .") from exc

    return create_agent(
        model=model or create_model(),
        tools=[get_latest_test_report, get_failure_detail],
        response_format=ToolStrategy(RiskAnalysisSchema),
        system_prompt="""你是研发任务交付风险分析 Agent。

必须先调用 get_latest_test_report 查询测试结果。
如果 failed 大于 0，再调用 get_failure_detail 查询具体失败原因；如果没有失败测试，不要调用失败详情 Tool。
只根据 Tool 返回的数据分析，不得编造测试结果。
存在失败测试时 riskLevel 必须是 high。
最后按照指定结构返回风险结论。""",
    )


def get_risk_agent():
    """延迟创建 Agent，使 routes 和 mermaid 命令不依赖模型环境变量。"""

    global _risk_agent

    if _risk_agent is not None:
        return _risk_agent

    _risk_agent = create_risk_agent()

    return _risk_agent


def load_task(state: DeliveryWorkflowState) -> dict[str, Any]:
    """Node：查询任务。"""

    print(f"[Node:load_task] 查询任务：{state['taskId']}")

    task = TASKS.get(state["taskId"])

    return {
        "task": TaskSchema(**task).model_dump() if task else None,

        # Node 版 StateSchema 可以给字段设置默认值。
        # Python TypedDict 本身没有默认值能力，
        # 所以这里显式补齐外层 Workflow 后续会读取的默认字段。
        "riskAnalysis": state.get("riskAnalysis"),
        "agentToolPath": state.get("agentToolPath", []),
        "result": state.get("result"),
        "executionPath": "load_task",
    }


def route_task(state: DeliveryWorkflowState) -> Literal["missing", "completed", "needs_analysis"]:
    """Conditional Edge：使用明确的业务规则选择下一条流程。"""

    if not state.get("task"):
        return "missing"

    if state["task"]["status"] == "completed":
        return "completed"

    return "needs_analysis"


def handle_missing_task(state: DeliveryWorkflowState) -> dict[str, Any]:
    """Node：处理不存在的任务。"""

    print("[Node:handle_missing] 任务不存在，跳过 Agent")

    return {
        "result": WorkflowResultSchema(
            status="missing",
            summary=f"没有找到任务 {state['taskId']}。",
            nextAction="请检查任务编号以后重新提交。",
        ).model_dump(),
        "executionPath": "handle_missing",
    }


def handle_completed_task(state: DeliveryWorkflowState) -> dict[str, Any]:
    """Node：处理已经完成的任务。"""

    print("[Node:handle_completed] 任务已经完成，跳过 Agent")

    task = state["task"]

    return {
        "result": WorkflowResultSchema(
            status="completed",
            summary=f"{task['title']} 已经完成。",
            nextAction="无需继续分析交付风险。",
        ).model_dump(),
        "executionPath": "handle_completed",
    }


def tool_call_name(tool_call: Any) -> str | None:
    """兼容 LangChain ToolCall dict 和测试中使用的简单对象。"""

    if isinstance(tool_call, dict):
        return tool_call.get("name")

    return getattr(tool_call, "name", None)


def extract_business_tool_path(messages: list[Any]) -> list[str]:
    """从 Agent 消息历史中提取实际发生过的业务 Tool Call。"""

    business_tool_names = {
        "get_latest_test_report",
        "get_failure_detail",
    }
    tool_path: list[str] = []

    for message in messages:
        for tool_call in getattr(message, "tool_calls", []) or []:
            name = tool_call_name(tool_call)

            if name in business_tool_names:
                tool_path.append(name)

    return tool_path


def structured_response_from_agent_result(agent_result: Any) -> Any:
    """兼容 Python structured_response 与 Node 课程中的 structuredResponse 命名。"""

    if isinstance(agent_result, dict):
        if "structured_response" in agent_result:
            return agent_result["structured_response"]

        return agent_result.get("structuredResponse")

    if hasattr(agent_result, "structured_response"):
        return getattr(agent_result, "structured_response")

    return getattr(agent_result, "structuredResponse", None)


def messages_from_agent_result(agent_result: Any) -> list[Any]:
    if isinstance(agent_result, dict):
        return list(agent_result.get("messages", []))

    return list(getattr(agent_result, "messages", []))


def normalize_risk_analysis(value: Any) -> dict[str, Any]:
    """把 Agent 的结构化输出转换成外层 Workflow State 所需要的 dict。"""

    if isinstance(value, BaseModel):
        value = value.model_dump()

    if value is None:
        raise RuntimeError("Agent 没有返回结构化风险分析结果。")

    return RiskAnalysisSchema(**value).model_dump()


def build_agent_prompt(task: dict[str, Any]) -> str:
    """将外层 Workflow State 中的任务信息转换成 Agent 的 messages 输入。"""

    return f"""请分析下面这项研发任务的交付风险：

任务编号：{task['taskId']}
任务名称：{task['title']}
负责人：{task['owner']}
截止日期：{task['dueDate']}
代码仓库：{task['repository']}"""


def analyze_delivery_risk(
    state: DeliveryWorkflowState,
    *,
    agent_instance: Any | None = None,
) -> dict[str, Any]:
    """Node：把外层 Workflow State 转换成 Agent 输入，再把 Agent 输出写回 State。

    外层 Workflow 关心 task、riskAnalysis 和 result；
    内层 Agent 则使用 messages、Tool Call 和 ToolMessage 完成自主循环。
    """

    print("[Node:risk_agent] 进入 LangChain Agent")

    # 获取已经配置好的风险分析 Agent。
    # Agent 内部负责模型调用、Tool Calling 和结构化结果生成。
    agent = agent_instance or get_risk_agent()

    # 从这里开始，控制权进入 Agent：
    # Agent 会根据任务信息自主判断是否以及按什么顺序调用 Tool，
    # 并在 Tool 执行结果基础上继续推理，直到生成最终风险分析结果。
    agent_result = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": build_agent_prompt(state["task"]),
                }
            ],
        }
    )

    # 这里只关心与风险分析直接相关的 Tool，
    # 避免把其他内部或辅助 Tool 记录到 agentToolPath 中。
    agent_tool_path = extract_business_tool_path(messages_from_agent_result(agent_result))

    # 将 Agent 的执行结果重新转换成外层 Workflow State 所需要的数据。
    # LangGraph Node 返回的对象会用于更新当前 State。
    return {
        # Agent 根据预定义 Structured Output Schema
        # 生成的最终风险分析结果。
        "riskAnalysis": normalize_risk_analysis(
            structured_response_from_agent_result(agent_result)
        ),

        # 本次 Agent 实际经过的业务 Tool 调用路径。
        "agentToolPath": agent_tool_path,

        # 标记当前分析结果来自 risk_agent 节点，
        # 供后续节点记录或展示整体 Workflow 执行路径。
        "executionPath": "risk_agent",
    }


def finalize_analysis(state: DeliveryWorkflowState) -> dict[str, Any]:
    """Node：使用确定性规则把 Agent 分析结果转换成业务状态。"""

    print("[Node:finalize_analysis] 验收 Agent 分析结果")

    if not state.get("riskAnalysis"):
        raise RuntimeError("Agent 没有返回结构化风险分析结果。")

    blocked = state["riskAnalysis"]["riskLevel"] == "high"

    return {
        "result": WorkflowResultSchema(
            status="blocked" if blocked else "review",
            summary=state["riskAnalysis"]["summary"],
            nextAction=(
                "先修复失败测试，再重新发起交付检查。"
                if blocked
                else "风险可控，可以进入人工验收。"
            ),
        ).model_dump(),
        "executionPath": "finalize_analysis",
    }


def create_delivery_workflow(*, agent_instance: Any | None = None):
    """创建外层 LangGraph Workflow。

    START → load_task
                 ├─ missing        → handle_missing   → END
                 ├─ completed      → handle_completed → END
                 └─ needs_analysis → risk_agent → finalize_analysis → END
    """

    graph_builder = StateGraph(DeliveryWorkflowState)

    (
        graph_builder
        # 注册外层 Workflow 中的 Node。
        .add_node("load_task", load_task)
        .add_node("handle_missing", handle_missing_task)
        .add_node("handle_completed", handle_completed_task)
        .add_node(
            "risk_agent",
            lambda state: analyze_delivery_risk(
                state,
                agent_instance=agent_instance,
            ),
        )
        .add_node("finalize_analysis", finalize_analysis)
        # Graph 启动以后首先进入 load_task。
        .add_edge(START, "load_task")
        # load_task 执行完成后，
        # 使用 route_task 的确定性业务规则选择下一条分支。
        .add_conditional_edges(
            "load_task",
            route_task,
            {
                "missing": "handle_missing",
                "completed": "handle_completed",
                "needs_analysis": "risk_agent",
            },
        )
        .add_edge("handle_missing", END)
        .add_edge("handle_completed", END)
        .add_edge("risk_agent", "finalize_analysis")
        .add_edge("finalize_analysis", END)
    )

    return graph_builder.compile()


delivery_workflow = create_delivery_workflow()


def print_result(result: DeliveryWorkflowState) -> None:
    print("外层执行路径：", " -> ".join(result["executionPath"]))

    agent_tool_path = result.get("agentToolPath", [])

    if agent_tool_path:
        print("内层 Agent Tool：", " -> ".join(agent_tool_path))
    else:
        print("内层 Agent Tool：未进入 Agent")

    print("最终业务结果：")
    print(json.dumps(result["result"], ensure_ascii=False, indent=2))


def run_scenario(task_id: str, *, workflow: Any | None = None) -> DeliveryWorkflowState:
    print(f"\n================ {task_id} ================")

    result = (workflow or delivery_workflow).invoke({"taskId": task_id})
    print_result(result)

    return result


def run_demo() -> None:
    run_scenario("DEV-1024")
    run_scenario("DEV-2048")
    run_scenario("DEV-9999")


def run_routes() -> None:
    run_scenario("DEV-2048")
    run_scenario("DEV-9999")


def print_mermaid() -> str:
    mermaid = delivery_workflow.get_graph().draw_mermaid()
    print(mermaid)

    return mermaid


def main(command: str = "demo") -> None:
    if command == "demo":
        run_demo()
    elif command == "routes":
        run_routes()
    elif command == "mermaid":
        print_mermaid()
    else:
        raise RuntimeError(f"未知命令：{command}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo")

"""
使用 LangGraph State、Node、Edge 与 Conditional Edge 实现研发任务分流。

这个 Python 版本保留 Node 版的教学结构：

- State：Graph 运行期间共享的数据；
- Node：真正执行某一步业务逻辑；
- Edge：描述固定执行顺序；
- Conditional Edge：根据当前 State 动态选择下一步分支；
- Reducer：把多个 Node 对同一个字段的更新合并起来。
"""

from __future__ import annotations

import json
import sys
from typing import Annotated, Any, Literal, NotRequired, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel


"""
模拟研发任务系统中的任务数据。

不同任务会触发不同的 Graph 分支：
- DEV-1024：任务进行中，进入 active 分支
- DEV-2048：任务已完成，进入 completed 分支
- 其他不存在的任务编号：进入 missing 分支
"""
TASKS = {
    "DEV-1024": {
        "taskId": "DEV-1024",
        "title": "为任务列表增加 priority 筛选",
        "status": "in_progress",
        "owner": "小明",
        "dueDate": "2026-08-20",
    },
    "DEV-2048": {
        "taskId": "DEV-2048",
        "title": "修复导出文件名称乱码问题",
        "status": "completed",
        "owner": "小李",
        "dueDate": "2026-08-12",
    },
}


class TaskSchema(BaseModel):
    """单个任务的数据结构。

    后续会作为 Graph State 中 task 字段的类型约束。
    """

    taskId: str
    title: str
    status: Literal["in_progress", "completed"]
    owner: str
    dueDate: str


class ResultSchema(BaseModel):
    """Graph 最终处理结果的数据结构。

    type 用来表示任务最终进入了哪一种业务分支。
    """

    type: Literal["active", "completed", "missing"]
    summary: str
    nextAction: str


def append_execution_path(current: list[str] | None, node_name: str | list[str] | None) -> list[str]:
    """把每个 Node 写入的节点名称追加到执行路径中。

    Node 版使用 ReducedValue，让每个 Node 只返回一个字符串，
    reducer 负责把字符串追加到数组里。

    Python LangGraph 通过 Annotated 字段声明 reducer。
    这里同样允许 Node 返回单个节点名称，从而保持课程讲解语义一致。
    """

    current_path = current or []

    if node_name is None:
        return current_path

    if isinstance(node_name, list):
        return [*current_path, *node_name]

    return [*current_path, node_name]


class TaskRoutingState(TypedDict, total=False):
    """定义整个 StateGraph 运行期间共享的 State。

    可以把 State 理解为：

       Graph 中所有 Node 共同读写的一份运行时数据。

    Node 不需要直接调用其他 Node，
    而是通过读取 State、返回 State 更新来完成数据传递。
    """

    # 当前需要查询的任务编号。
    #
    # invoke() 启动 Graph 时由外部传入。
    taskId: str

    # 查询得到的任务信息。
    #
    # 初始值可以不传，
    # load_task Node 执行后会更新这个字段。
    task: NotRequired[dict[str, Any] | None]

    # Graph 最终生成的业务处理结果。
    #
    # 初始值可以不传，
    # 后续不同分支 Node 会写入对应结果。
    result: NotRequired[dict[str, Any] | None]

    # 记录 Graph 实际经过的 Node。
    #
    # 这个字段使用 reducer，与普通 State 字段不同：
    #
    # 普通字段：
    #    后一次更新通常覆盖前一次更新。
    #
    # reducer 字段：
    #    每次 Node 返回新值时，会通过 reducer
    #    将新值与旧值合并。
    #
    # 因此 executionPath 可以不断累积：
    #
    #    ['load_task']
    #        ↓
    #    ['load_task', 'handle_active']
    executionPath: Annotated[list[str], append_execution_path]


def load_task(state: TaskRoutingState) -> dict[str, Any]:
    """Node：读取任务信息。

    Node 的基本职责通常是：

       State
         ↓
       执行业务逻辑
         ↓
       返回需要更新的部分 State

    LangGraph 会把这里返回的数据自动合并回 Graph State。
    """

    task = TASKS.get(state["taskId"])

    print(f"[Node:load_task] 查询任务：{state['taskId']}")

    return {
        # 更新 task 字段。
        #
        # 使用 Pydantic 过一层 Schema，目的是保留 Node 版 zod schema
        # 所表达的数据结构约束。
        "task": TaskSchema(**task).model_dump() if task else None,

        # executionPath 使用 reducer，
        # 因此这里返回字符串即可，由 reducer 负责追加。
        "executionPath": "load_task",
    }


def route_task(state: TaskRoutingState) -> Literal["active", "completed", "missing"]:
    """Conditional Edge 使用的路由函数。

    它本身不是一个业务处理 Node，
    主要负责根据当前 State 判断下一步应该走哪个分支。

    返回值会与 add_conditional_edges() 中定义的映射关系对应。
    """

    # 没查到任务。
    if not state.get("task"):
        return "missing"

    # 已完成任务。
    if state["task"]["status"] == "completed":
        return "completed"

    # 其他情况进入进行中任务分支。
    return "active"


def handle_active_task(state: TaskRoutingState) -> dict[str, Any]:
    """Node：处理仍在进行中的任务。

    当前分支只会在：

       route_task() == 'active'

    时执行。
    """

    task = state["task"]

    print("[Node:handle_active] 生成进行中任务的处理建议")

    return {
        "result": ResultSchema(
            type="active",
            summary=f"{task['title']} 当前由 {task['owner']} 负责，任务仍在进行中。",
            nextAction=f"继续推进开发，并在 {task['dueDate']} 前完成测试。",
        ).model_dump(),
        "executionPath": "handle_active",
    }


def handle_completed_task(state: TaskRoutingState) -> dict[str, Any]:
    """Node：处理已经完成的任务。

    已完成任务不应该继续生成开发建议，
    因此单独进入 completed 分支。
    """

    task = state["task"]

    print("[Node:handle_completed] 返回已完成结论")

    return {
        "result": ResultSchema(
            type="completed",
            summary=f"{task['title']} 已经完成。",
            nextAction="不再进入开发流程，可以继续检查发布或验收状态。",
        ).model_dump(),
        "executionPath": "handle_completed",
    }


def handle_missing_task(state: TaskRoutingState) -> dict[str, Any]:
    """Node：处理任务不存在的情况。

    当 load_task 没有查询到任务时，
    Conditional Edge 会把执行流程路由到这里。
    """

    print("[Node:handle_missing] 请求补充有效任务编号")

    return {
        "result": ResultSchema(
            type="missing",
            summary=f"没有找到任务 {state['taskId']}。",
            nextAction="请检查任务编号，补充有效编号以后再重新执行。",
        ).model_dump(),
        "executionPath": "handle_missing",
    }


def create_task_routing_graph():
    """创建任务分流 StateGraph。

    Graph 的整体结构：

                     ┌→ handle_active ───────→ END
                     │
    START → load_task ├→ handle_completed ───→ END
                     │
                     └→ handle_missing ──────→ END

    其中：

    - Node：真正执行处理逻辑
    - Edge：决定固定的执行顺序
    - Conditional Edge：根据 State 动态决定下一步
    """

    graph_builder = StateGraph(TaskRoutingState)

    (
        graph_builder
        # 注册 Graph 中的 Node。
        #
        # 第一个参数是 Node 名称，
        # 第二个参数是 Node 实际执行的函数。
        .add_node("load_task", load_task)
        .add_node("handle_active", handle_active_task)
        .add_node("handle_completed", handle_completed_task)
        .add_node("handle_missing", handle_missing_task)
        # 固定 Edge：
        #
        # Graph 启动以后，首先进入 load_task。
        #
        # START 是 LangGraph 提供的特殊起点节点。
        .add_edge(START, "load_task")
        # Conditional Edge：
        #
        # load_task 执行完成后，
        # 调用 route_task(state) 判断下一步应该进入哪个 Node。
        #
        # route_task 返回：
        #
        # active
        # completed
        # missing
        #
        # 再通过下面的映射找到真正需要执行的 Node。
        .add_conditional_edges(
            "load_task",
            route_task,
            {
                "active": "handle_active",
                "completed": "handle_completed",
                "missing": "handle_missing",
            },
        )
        # 三个业务分支处理完成后都结束 Graph。
        #
        # END 是 LangGraph 提供的特殊终点节点。
        .add_edge("handle_active", END)
        .add_edge("handle_completed", END)
        .add_edge("handle_missing", END)
    )

    # compile() 把前面声明的 State、Node 和 Edge
    # 编译成真正可以 invoke()/stream() 的可执行 Graph。
    return graph_builder.compile()


task_routing_graph = create_task_routing_graph()


def run_scenario(task_id: str) -> TaskRoutingState:
    """执行一个完整的 Graph 场景。"""

    print(f"\n================ {task_id} ================")

    # invoke() 启动一次完整 Graph Run。
    #
    # 初始 State：
    #
    # {
    #   taskId
    # }
    #
    # LangGraph 会按照 Edge 和 Conditional Edge
    # 自动执行后续 Node，直到到达 END。
    #
    # result 是 Graph 执行结束后的最终 State。
    result = task_routing_graph.invoke({"taskId": task_id})

    print("执行路径：", " -> ".join(result["executionPath"]))
    print("处理结果：", result["result"])

    return result


def run_demo() -> None:
    """依次执行三个任务，用于验证 Conditional Edge 的三条分支。"""

    # active 分支。
    run_scenario("DEV-1024")

    # completed 分支。
    run_scenario("DEV-2048")

    # missing 分支。
    run_scenario("DEV-9999")


def run_stream_demo() -> None:
    """使用 stream() 观察 Graph 的执行过程。

    invoke() 更关注：

       Graph 最终执行结果

    stream() 更关注：

       Graph 执行过程中每一步发生了什么
    """

    print("\n========== Stream：DEV-1024 ==========")

    # stream_mode='updates'
    #
    # 表示每次 Node 执行完成后，
    # 返回这个 Node 对 State 产生的增量更新。
    #
    # 而不是每次都返回完整 State。
    stream = task_routing_graph.stream(
        {"taskId": "DEV-1024"},
        stream_mode="updates",
    )

    # Graph Stream 是迭代器，
    # 因此可以逐步读取 Node 更新。
    for update in stream:
        print(json.dumps(update, ensure_ascii=False, indent=2))


def print_mermaid() -> str:
    """输出当前 Graph 的 Mermaid 描述。

    可以复制输出内容到 Mermaid 编辑器中，
    直接查看 Graph 的节点和 Edge 结构。
    """

    mermaid = task_routing_graph.get_graph().draw_mermaid()
    print(mermaid)

    return mermaid


def main(mode: str = "demo") -> None:
    """根据命令行参数决定演示模式。

    启动时例如：

    python task_routing_graph.py
    python task_routing_graph.py stream
    python task_routing_graph.py mermaid
    """

    if mode == "stream":
        # 查看 Graph 每一步 State 更新。
        run_stream_demo()
    elif mode == "mermaid":
        # 输出 Graph 的 Mermaid 结构。
        print_mermaid()
    else:
        # 默认执行三种任务分支。
        run_demo()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo")

"""
LangChain Middleware。

这个案例在第五章 05 小节的研发任务风险分析 Agent 上继续增加：

- 根据 Runtime Context 动态过滤 Tool；
- 在 Tool 执行前再次校验角色权限；
- 限制单次 Agent Run 的模型与 Tool 调用次数；
- 校验 Tool 返回结果，并对暂时性错误自动重试。
"""


import json
import os
import uuid
from typing import Any, Callable, Literal, TypedDict

from langchain.agents.middleware import (
    AgentMiddleware,
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
    ToolRetryMiddleware,
)
from langchain.tools import ToolRuntime
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel, Field, TypeAdapter, ValidationError


PRINCIPALS = {
    "developer-session": {
        "userId": "U1001",
        "tenantId": "blue-whale",
        "tenantName": "蓝鲸科技",
        "roles": ["developer"],
    },
    "maintainer-session": {
        "userId": "U1002",
        "tenantId": "blue-whale",
        "tenantName": "蓝鲸科技",
        "roles": ["developer", "maintainer"],
    },
}


TASKS = {
    "blue-whale": {
        "DEV-1024": {
            "taskId": "DEV-1024",
            "title": "为任务列表增加 priority 筛选",
            "status": "in_progress",
            "owner": "小明",
            "dueDate": "2026-08-15",
            "repository": "task-service",
        }
    }
}


TEST_REPORTS = {
    "blue-whale": {
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
}


FAILURE_DETAILS = {
    "blue-whale": {
        "task-service": {
            "errorType": "AssertionError",
            "location": "src/tasks/task.service.spec.ts:84",
            "actual": "medium",
            "expected": "high",
        }
    }
}


REPORT_ATTEMPTS: dict[str, int] = {}


class RuntimeContext(TypedDict):
    """每次 Agent Run 的可信运行信息。

    simulateMalformedReport 只用于演示上游系统第一次返回残缺数据，
    真实项目中可以替换成数据库、HTTP 服务或测试平台的实际异常。
    """

    userId: str
    tenantId: str
    tenantName: str
    roles: list[str]
    runId: str
    simulateMalformedReport: bool


class TaskInput(BaseModel):
    taskId: str = Field(description="研发任务编号，例如 DEV-1024")


class RepositoryInput(BaseModel):
    repository: str = Field(description="get_task 返回的代码仓库名称")


class TestReportFound(BaseModel):
    found: Literal[True]
    repository: str
    passed: int
    failed: int
    failures: list[str]


class TestReportNotFound(BaseModel):
    found: Literal[False]
    repository: str
    message: str


class RiskAnalysis(BaseModel):
    taskId: str
    riskLevel: Literal["low", "medium", "high"]
    summary: str
    evidence: list[str] = Field(min_length=2)
    suggestions: list[str] = Field(min_length=1)


TEST_REPORT_RESULT = TypeAdapter(TestReportFound | TestReportNotFound)


def authenticate(session_id: str) -> dict[str, Any]:
    """根据 sessionId 获取服务端已经认证过的身份。"""

    principal = PRINCIPALS.get(session_id)

    if not principal:
        raise RuntimeError("当前会话没有通过身份认证。")

    return principal


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


def context_value(context: Any, key: str) -> Any:
    """兼容 dict 和对象形式的 Runtime Context。"""

    if isinstance(context, dict):
        return context[key]

    return getattr(context, key)


def get_context_roles(context: Any) -> list[str]:
    return list(context_value(context, "roles"))


def lookup_task(task_id: str, context: RuntimeContext | Any) -> dict[str, Any]:
    tenant_id = context_value(context, "tenantId")
    task = TASKS.get(tenant_id, {}).get(task_id)

    if not task:
        return {
            "found": False,
            "taskId": task_id,
            "message": "当前租户下没有找到对应任务",
        }

    return {
        "found": True,
        **task,
    }


def lookup_latest_test_report(repository: str, context: RuntimeContext | Any) -> dict[str, Any]:
    tenant_id = context_value(context, "tenantId")
    run_id = context_value(context, "runId")
    simulate_malformed_report = context_value(context, "simulateMalformedReport")

    attempt_key = f"{run_id}:{repository}"
    attempt = REPORT_ATTEMPTS.get(attempt_key, 0) + 1
    REPORT_ATTEMPTS[attempt_key] = attempt

    print(f"[Tool] get_latest_test_report 第 {attempt} 次执行")

    if simulate_malformed_report and attempt == 1:
        return {
            "found": True,
            "repository": repository,
        }

    report = TEST_REPORTS.get(tenant_id, {}).get(repository)

    if not report:
        return {
            "found": False,
            "repository": repository,
            "message": "当前租户下没有找到测试报告",
        }

    return {
        "found": True,
        **report,
    }


def lookup_failure_detail(repository: str, context: RuntimeContext | Any) -> dict[str, Any]:
    tenant_id = context_value(context, "tenantId")
    detail = FAILURE_DETAILS.get(tenant_id, {}).get(repository)

    if not detail:
        return {
            "found": False,
            "repository": repository,
            "message": "没有找到失败详情",
        }

    return {
        "found": True,
        "repository": repository,
        **detail,
    }


@tool(
    "get_task",
    description="查询当前租户中的研发任务，并返回任务对应的代码仓库",
    args_schema=TaskInput,
)
def get_task(taskId: str, runtime: ToolRuntime) -> str:
    """查询当前租户中的研发任务。"""

    print(f"[Tool] get_task 查询任务：{taskId}")

    return json.dumps(lookup_task(taskId, runtime.context), ensure_ascii=False)


@tool(
    "get_latest_test_report",
    description="查询当前租户中指定代码仓库的最新自动化测试报告",
    args_schema=RepositoryInput,
)
def get_latest_test_report(repository: str, runtime: ToolRuntime) -> str:
    """查询当前租户中指定代码仓库的最新自动化测试报告。"""

    return json.dumps(
        lookup_latest_test_report(repository, runtime.context),
        ensure_ascii=False,
    )


@tool(
    "get_failure_detail",
    description="查询失败测试的内部断言、代码位置与实际值，仅维护者可以使用",
    args_schema=RepositoryInput,
)
def get_failure_detail(repository: str, runtime: ToolRuntime) -> str:
    """失败详情包含内部测试文件位置，只允许 maintainer 角色使用。"""

    print(f"[Tool] get_failure_detail 查询失败详情：{repository}")

    return json.dumps(lookup_failure_detail(repository, runtime.context), ensure_ascii=False)


# 当前风险分析 Agent 注册的完整 Tool 集合。
#
# - get_task：根据任务 ID 查询研发任务基础信息
# - get_latest_test_report：根据任务所属仓库查询最新测试报告
# - get_failure_detail：在测试失败时进一步查询具体失败详情
#
# 后续 PermissionMiddleware 会根据当前用户角色，
# 从 ALL_TOOLS 中过滤出本次模型实际可见、可调用的 Tool。
ALL_TOOLS = [get_task, get_latest_test_report, get_failure_detail]


# Tool 与角色之间的权限映射关系。
#
# Key 表示 Tool 名称，
# Value 表示允许使用该 Tool 的角色列表。
#
# 当前权限规则：
# - developer：可以查询任务和最新测试报告
# - maintainer：除了上述能力外，还可以进一步查询失败详情
#
# PermissionMiddleware 会通过这份配置判断：
# 1. 某个 Tool 是否应该对当前模型可见
# 2. 某个 Tool 在真正执行前是否具有调用权限
TOOL_ROLES = {
    # developer 和 maintainer 都可以查询研发任务基础信息。
    "get_task": ["developer", "maintainer"],

    # developer 和 maintainer 都可以查询仓库最新测试报告。
    "get_latest_test_report": ["developer", "maintainer"],

    # 失败详情属于权限更高的能力，只允许 maintainer 使用。
    "get_failure_detail": ["maintainer"],
}


def can_use_tool(roles: list[str], tool_name: str) -> bool:
    allowed_roles = TOOL_ROLES.get(tool_name, [])
    return any(role in allowed_roles for role in roles)


class PermissionMiddleware(AgentMiddleware):
    """Tool 权限控制 Middleware。

    主要负责两层权限控制：

    1. 在调用模型之前，根据当前用户角色过滤模型可以看到的 Tool。
    2. 在真正执行 Tool 之前，再次校验当前角色是否拥有执行权限。

    第一层属于“能力可见性控制”，
    第二层属于“执行权限兜底校验”。
    """

    @property
    def name(self) -> str:
        return "PermissionMiddleware"

    def wrap_model_call(self, request, handler):
        """包装模型调用过程。"""

        # 从 Agent Runtime Context 中读取当前用户的角色。
        roles = get_context_roles(request.runtime.context)

        # 从当前已经注册的 Tool 中，
        # 筛选出当前角色有权限使用的 Tool。
        #
        # Python 版本会保留不在 TOOL_ROLES 中的工具，
        # 例如 Structured Output 内部工具，避免误删框架生成的输出工具。
        allowed_tools = [
            current_tool
            for current_tool in request.tools
            if isinstance(current_tool, dict)
            or current_tool.name not in TOOL_ROLES
            or can_use_tool(roles, current_tool.name)
        ]

        print(
            "[Middleware:Permission] 模型可见 Tool："
            + ", ".join(
                current_tool.get("name", "<provider-tool>")
                if isinstance(current_tool, dict)
                else current_tool.name
                for current_tool in allowed_tools
            )
        )

        # 继续执行后续 Middleware / Model Call。
        #
        # 这里不会把原始 request.tools 直接传给模型，
        # 而是替换成经过权限过滤后的 allowed_tools。
        #
        # 因此模型只能感知并调用当前角色有权限使用的 Tool。
        return handler(request.override(tools=allowed_tools))

    def wrap_tool_call(self, request, handler):
        """包装 Tool 的实际执行过程。"""

        # 获取当前用户角色。
        roles = get_context_roles(request.runtime.context)

        # 获取模型本次准备调用的 Tool 名称。
        tool_name = request.tool_call["name"]

        # 再次检查当前角色是否有权执行该 Tool。
        #
        # 如果没有权限，则直接阻止 Tool 调用，
        # 不会继续进入真正的 Tool Handler。
        if tool_name in TOOL_ROLES and not can_use_tool(roles, tool_name):
            raise PermissionError(f"当前角色无权执行 Tool：{tool_name}")

        print(f"[Middleware:Permission] 允许执行：{tool_name}")

        # 权限校验通过，继续执行真正的 Tool。
        return handler(request)


class InvalidToolResultError(Exception):
    """测试报告结果不满足业务结构要求。"""


def is_invalid_tool_result(error: BaseException) -> bool:
    current_error: BaseException | None = error

    while current_error is not None:
        if isinstance(current_error, InvalidToolResultError):
            return True

        current_error = current_error.__cause__

    return False


def tool_message_text(tool_message: ToolMessage) -> str:
    if isinstance(tool_message.content, str):
        return tool_message.content

    return json.dumps(tool_message.content, ensure_ascii=False)


class ResultValidationMiddleware(AgentMiddleware):
    """Tool 结果校验 Middleware。

    当前只对 get_latest_test_report 的返回结果进行严格校验。

    主要流程：
    1. 先执行真正的 Tool。
    2. 如果不是 get_latest_test_report，直接返回结果。
    3. 如果是测试报告 Tool，则解析 ToolMessage 中的 JSON。
    4. 使用 TestReportResult Schema 校验结果结构。
    5. 校验失败时抛出 InvalidToolResultError，
       让外层的 Retry Middleware 决定是否重新执行 Tool。

    只有通过校验的测试报告，才允许继续进入后续 Agent 流程。
    """

    @property
    def name(self) -> str:
        return "ResultValidationMiddleware"

    def wrap_tool_call(self, request, handler):
        """包装 Tool 调用过程，对 Tool 返回结果进行校验。"""

        # 先执行真正的 Tool。
        #
        # result 通常是 Tool 执行完成后生成的 ToolMessage。
        result = handler(request)

        # 当前 Middleware 只校验 get_latest_test_report。
        #
        # 其他 Tool 的返回结果不经过这里的 TestReportResult 校验，
        # 直接返回给 Agent Runtime。
        if request.tool_call["name"] != "get_latest_test_report":
            return result

        # 从 ToolMessage 中提取文本内容，并解析成 JSON。
        #
        # 如果 Tool 返回的内容连合法 JSON 都不是，
        # 说明这次结果无法作为可信 Observation 使用。
        try:
            data = json.loads(tool_message_text(result))
        except Exception as exc:
            raise InvalidToolResultError("测试报告不是合法 JSON。") from exc

        # 使用 Pydantic Schema 校验测试报告的数据结构。
        try:
            TEST_REPORT_RESULT.validate_python(data)
        except ValidationError as exc:
            print("[Middleware:Validation] 测试报告字段不完整，拒绝写入 State")
            raise InvalidToolResultError("测试报告缺少 passed、failed 或 failures。") from exc

        # 结果结构完整，可以作为有效 Tool Observation 继续使用。
        print("[Middleware:Validation] 测试报告通过校验")

        return result


def create_risk_agent(
    *,
    model_run_limit: int = 5,
    tool_run_limit: int = 4,
    model: Any | None = None,
):
    """创建研发任务交付风险分析 Agent。

    Args:
        model_run_limit: 单次 Agent Run 最多允许调用模型的次数。
        tool_run_limit: 单次 Agent Run 最多允许调用 Tool 的次数。
    """

    try:
        from langchain.agents import create_agent
        from langchain.agents.structured_output import ToolStrategy
    except ImportError as exc:
        raise RuntimeError("缺少 langchain 依赖，请先执行：python -m pip install -e .") from exc

    return create_agent(
        # 创建当前 Agent 使用的 LLM。
        model=model or create_model(),

        # 注册 Agent 可以调用的全部 Tool。
        # 实际运行过程中，Middleware 还可以根据权限进一步控制 Tool 的可见性。
        tools=ALL_TOOLS,

        # 定义 Runtime Context 的结构，
        # 例如当前用户、租户、角色等运行时上下文信息。
        context_schema=RuntimeContext,

        # 要求 Agent 最终按照 RiskAnalysis Schema 返回结构化结果。
        response_format=ToolStrategy(RiskAnalysis),

        # 定义 Agent 的任务目标以及 Tool 调用约束。
        system_prompt="""你是研发任务交付风险分析 Agent。

必须先调用 get_task，再使用返回的 repository 调用 get_latest_test_report。
如果测试失败，并且当前可用 Tool 中存在 get_failure_detail，则继续查询失败详情。
只能使用当前可见的 Tool，不得声称自己调用了不存在的能力。
最后根据已经通过校验的 Tool 结果，返回结构化风险结论。""",

        middleware=[
            # 根据当前 Runtime Context 对 Tool 权限进行过滤或控制。
            #
            # 例如不同用户、角色或租户可能只能看到部分 Tool，
            # Agent 只能调用当前实际可见的能力。
            PermissionMiddleware(),

            # 限制单次 Agent Run 中模型调用次数。
            #
            # 超过 model_run_limit 后直接抛出错误，
            # 防止 Agent 因反复推理而无限消耗模型调用次数。
            ModelCallLimitMiddleware(
                run_limit=model_run_limit,
                exit_behavior="error",
            ),

            # 限制单次 Agent Run 中 Tool 调用次数。
            #
            # 超过 tool_run_limit 后直接终止，
            # 防止 Agent 出现工具调用死循环或无效重复调用。
            ToolCallLimitMiddleware(
                run_limit=tool_run_limit,
                exit_behavior="error",
            ),

            # 为指定 Tool 增加失败重试能力。
            #
            # Retry 必须包在 Validation 外层。
            # Validation 抛出的可重试错误，才能回到 Retry 再执行一次 Tool。
            ToolRetryMiddleware(
                tools=["get_latest_test_report"],
                max_retries=1,
                initial_delay=0,
                backoff_factor=0,
                jitter=False,
                retry_on=is_invalid_tool_result,
                on_failure="error",
            ),

            # 对 Tool 返回的结果进行统一校验。
            #
            # 如果返回结果缺少关键字段、格式不正确或不满足业务要求，
            # Middleware 会抛出校验异常。
            #
            # 当异常属于可重试错误时，
            # 外层的 ToolRetryMiddleware 会重新执行对应 Tool。
            ResultValidationMiddleware(),
        ],
    )


def build_runtime_context(
    *,
    session_id: str,
    simulate_malformed_report: bool = False,
) -> RuntimeContext:
    principal = authenticate(session_id)

    return {
        **principal,
        "runId": str(uuid.uuid4()),
        "simulateMalformedReport": simulate_malformed_report,
    }


def analyze_delivery_risk(
    *,
    session_id: str,
    question: str,
    simulate_malformed_report: bool = False,
    limits: dict[str, int] | None = None,
    agent_instance: Any | None = None,
) -> dict[str, Any]:
    context = build_runtime_context(
        session_id=session_id,
        simulate_malformed_report=simulate_malformed_report,
    )
    limits = limits or {}
    agent = agent_instance or create_risk_agent(
        model_run_limit=limits.get("modelRunLimit", 5),
        tool_run_limit=limits.get("toolRunLimit", 4),
    )

    return agent.invoke(
        {
            "messages": [{"role": "user", "content": question}],
        },
        context=context,
    )


def structured_response_from_result(result: dict[str, Any]) -> Any:
    if "structured_response" in result:
        return result["structured_response"]

    return result.get("structuredResponse")


def print_result(result: dict[str, Any]) -> None:
    print("\nstructured_response：")
    structured_response = structured_response_from_result(result)

    if isinstance(structured_response, BaseModel):
        structured_response = structured_response.model_dump()

    print(json.dumps(structured_response, ensure_ascii=False, indent=2))


def run_permission_demo() -> None:
    print("\n================ 权限：developer ================")
    developer_result = analyze_delivery_risk(
        session_id="developer-session",
        question="分析 DEV-1024 的交付风险，并尽可能查询失败测试详情。",
    )
    print_result(developer_result)

    print("\n================ 权限：maintainer ================")
    maintainer_result = analyze_delivery_risk(
        session_id="maintainer-session",
        question="分析 DEV-1024 的交付风险，并查询失败测试详情。",
    )
    print_result(maintainer_result)


def run_retry_demo() -> None:
    print("\n================ 结果校验与自动重试 ================")
    result = analyze_delivery_risk(
        session_id="maintainer-session",
        question="分析 DEV-1024 的交付风险，并查询失败测试详情。",
        simulate_malformed_report=True,
    )
    print_result(result)


def run_budget_demo() -> None:
    print("\n================ 模型调用预算 ================")

    try:
        analyze_delivery_risk(
            session_id="maintainer-session",
            question="分析 DEV-1024 的交付风险。",
            limits={
                "modelRunLimit": 1,
                "toolRunLimit": 4,
            },
        )
    except Exception as error:
        print("第二次模型调用以前，Agent 已停止：")
        print(error)

    print("\n================ Tool 调用预算 ================")

    try:
        analyze_delivery_risk(
            session_id="maintainer-session",
            question="分析 DEV-1024 的交付风险。",
            limits={
                "modelRunLimit": 5,
                "toolRunLimit": 1,
            },
        )
    except Exception as error:
        print("第二次 Tool 调用以前，Agent 已停止：")
        print(error)


COMMANDS: dict[str, Callable[[], None]] = {
    "permission": run_permission_demo,
    "retry": run_retry_demo,
    "budget": run_budget_demo,
}


def main(command: str = "demo") -> None:
    if command == "demo":
        run_permission_demo()
        run_retry_demo()
        run_budget_demo()
        return

    if command not in COMMANDS:
        raise RuntimeError(f"未知命令：{command}")

    COMMANDS[command]()


if __name__ == "__main__":
    import sys

    main(sys.argv[1] if len(sys.argv) > 1 else "demo")

"""Agentic RAG Workflow。

普通 RAG 通常是固定流程：

问题 → 检索 → 拼上下文 → 回答

Agentic RAG 会多一个“自主规划和校验”的过程：

1. 先判断这个问题到底需不需要查知识库；
2. 如果需要查，先规划需要哪些证据类型；
3. 逐类检索和校验证据，缺什么再补什么；
4. 证据不完整时拒答，而不是强行生成；
5. 生成答案后继续校验来源，避免模型引用不存在的资料。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Literal

from langgraph.graph import END, START, StateGraph
from typing_extensions import NotRequired, TypedDict

from knowledge import (
    append_unique,
    assess_evidence,
    build_search_query,
    search_knowledge as search_knowledge_base,
)


class AgenticRagState(TypedDict, total=False):
    """LangGraph 中流转的业务 State。

    为了和 Node 版本对照更直观，State 字段保留 camelCase 命名。
    Python 函数本身仍然使用 snake_case 命名。
    """

    question: str
    route: NotRequired[Literal["direct", "retrieve", "clarify"]]
    requiredEvidence: NotRequired[list[str]]
    missingEvidence: NotRequired[list[str]]
    searchedEvidenceTypes: NotRequired[list[str]]
    candidates: NotRequired[list[dict[str, Any]]]
    usableEvidence: NotRequired[list[dict[str, Any]]]
    rejectedEvidence: NotRequired[list[dict[str, str]]]
    searchAttempts: NotRequired[int]
    clarificationQuestion: NotRequired[str | None]
    finalAnswer: NotRequired[str]
    sourceIds: NotRequired[list[str]]
    outcome: NotRequired[Literal["answered", "direct", "clarify", "refused"]]
    trace: NotRequired[list[str]]


def normalize_structured(value: Any) -> dict[str, Any]:
    """兼容 dict、Pydantic Model 和其他结构化返回对象。"""

    if isinstance(value, dict):
        return value

    if hasattr(value, "model_dump"):
        return value.model_dump()

    raise RuntimeError("模型服务没有返回可识别的结构化结果。")


def get_service(services: Any, name: str) -> Callable[..., Any]:
    """同时兼容 dict 服务集合和对象方法服务集合。"""

    if isinstance(services, dict):
        service = services.get(name)
    else:
        service = getattr(services, name, None)

    if not callable(service):
        raise RuntimeError(f"模型服务缺少 {name} 方法。")

    return service


def call_service(services: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    """调用 Workflow 依赖的模型服务。"""

    return get_service(services, name)(*args, **kwargs)


def dedupe_evidence_types(evidence_types: list[str] | None) -> list[str]:
    """按出现顺序去重证据类型。"""

    return append_unique([], evidence_types or [])


def create_agentic_rag_graph(
    *,
    services: Any,
    principal: dict[str, Any],
    now: datetime,
    max_searches: int = 3,
):
    """创建 Agentic RAG 的 LangGraph Workflow。

    START → decide_request
              ├─ direct   → direct_answer → END
              ├─ clarify  → clarify_user  → END
              └─ retrieve → search_knowledge → assess_evidence
                                ├─ generate_answer → END
                                ├─ search_knowledge → ...
                                └─ refuse_answer → END
    """

    # 提前检查服务接口，避免 Workflow 执行到一半才发现依赖缺失。
    for service_name in ("decide", "direct", "answer"):
        get_service(services, service_name)

    if not principal.get("tenantId") or not principal.get("userId"):
        raise RuntimeError("缺少当前用户身份，无法执行 Agentic RAG。")

    if max_searches < 1:
        raise RuntimeError("max_searches 必须大于 0。")

    def decide_request(state: AgenticRagState) -> dict[str, Any]:
        """Node：判断用户请求应该如何处理。"""

        decision = normalize_structured(
            call_service(services, "decide", state["question"])
        )

        route = decision.get("route")
        required_evidence = dedupe_evidence_types(decision.get("requiredEvidence"))

        if route == "retrieve" and not required_evidence:
            raise RuntimeError("模型决定检索，但没有说明需要哪类证据。")

        reason = decision.get("reason", "未说明原因")

        return {
            "route": route,
            "requiredEvidence": required_evidence,
            "missingEvidence": [*required_evidence],
            "searchedEvidenceTypes": state.get("searchedEvidenceTypes", []),
            "candidates": state.get("candidates", []),
            "usableEvidence": state.get("usableEvidence", []),
            "rejectedEvidence": state.get("rejectedEvidence", []),
            "searchAttempts": state.get("searchAttempts", 0),
            "clarificationQuestion": decision.get("clarificationQuestion"),
            "sourceIds": state.get("sourceIds", []),
            "trace": [
                *state.get("trace", []),
                f"decide_request：{route}；{reason}",
            ],
        }

    def route_after_decision(
        state: AgenticRagState,
    ) -> Literal["direct", "clarify", "search"]:
        """Conditional Edge：根据模型的第一步决策选择下一条路径。"""

        if state.get("route") == "direct":
            return "direct"

        if state.get("route") == "clarify":
            return "clarify"

        return "search"

    def retrieve_missing_evidence(state: AgenticRagState) -> dict[str, Any]:
        """Node：只检索当前仍然缺失的第一类证据。"""

        missing_evidence = state.get("missingEvidence", [])
        evidence_type = missing_evidence[0] if missing_evidence else None

        if not evidence_type:
            raise RuntimeError("没有找到本轮需要补查的证据类型。")

        query = build_search_query(state["question"], evidence_type)

        # principal 由 Workflow 闭包传入。
        # 模型只负责选择 evidenceType，不能直接决定 tenantId。
        result = search_knowledge_base(
            principal=principal,
            evidence_type=evidence_type,
            query=query,
        )

        return {
            "searchAttempts": state.get("searchAttempts", 0) + 1,
            "searchedEvidenceTypes": append_unique(
                state.get("searchedEvidenceTypes", []),
                [evidence_type],
            ),
            "candidates": append_unique(
                state.get("candidates", []),
                result["candidates"],
                lambda chunk: chunk["id"],
            ),
            "trace": [
                *state.get("trace", []),
                f"search_knowledge：{evidence_type}；返回 {len(result['candidates'])} 条候选",
            ],
        }

    def grade_evidence(state: AgenticRagState) -> dict[str, Any]:
        """Node：校验证据是否真的可用。"""

        result = assess_evidence(
            candidates=state.get("candidates", []),
            principal=principal,
            required_evidence=state.get("requiredEvidence", []),
            now=now,
        )

        missing = result["missing"]

        return {
            "usableEvidence": result["usable"],
            "rejectedEvidence": result["rejected"],
            "missingEvidence": missing,
            "trace": [
                *state.get("trace", []),
                (
                    "assess_evidence：证据已经齐全"
                    if not missing
                    else f"assess_evidence：仍缺少 {'、'.join(missing)}"
                ),
            ],
        }

    def route_after_assessment(
        state: AgenticRagState,
    ) -> Literal["generate", "search", "refuse"]:
        """Conditional Edge：证据齐全则生成，仍缺证据则决定补查还是拒答。"""

        missing = state.get("missingEvidence", [])

        if not missing:
            return "generate"

        if state.get("searchAttempts", 0) >= max_searches:
            return "refuse"

        next_type = missing[0]

        # 如果某类证据已经查过一次仍然没有可用资料，
        # 继续查同一类证据只会原地循环，因此直接拒答。
        if next_type in state.get("searchedEvidenceTypes", []):
            return "refuse"

        return "search"

    def generate_answer(state: AgenticRagState) -> dict[str, Any]:
        """Node：基于可用证据生成答案，并校验来源引用。"""

        response = normalize_structured(
            call_service(
                services,
                "answer",
                {
                    "question": state["question"],
                    "evidence": state.get("usableEvidence", []),
                },
            )
        )

        source_ids = response.get("sourceIds", [])
        allowed_ids = {chunk["id"] for chunk in state.get("usableEvidence", [])}
        invalid_ids = [
            source_id for source_id in source_ids if source_id not in allowed_ids
        ]

        cited_types = {
            chunk["evidenceType"]
            for chunk in state.get("usableEvidence", [])
            if chunk["id"] in source_ids
        }
        missing_citation = any(
            evidence_type not in cited_types
            for evidence_type in state.get("requiredEvidence", [])
        )

        if invalid_ids or missing_citation:
            return {
                "outcome": "refused",
                "finalAnswer": "答案没有通过来源校验，本次不返回未经支持的业务结论。",
                "sourceIds": [],
                "trace": [
                    *state.get("trace", []),
                    "generate_answer：来源校验失败",
                ],
            }

        return {
            "outcome": "answered",
            "finalAnswer": response["answer"],
            "sourceIds": source_ids,
            "trace": [
                *state.get("trace", []),
                "generate_answer：答案和来源校验通过",
            ],
        }

    def direct_answer(state: AgenticRagState) -> dict[str, Any]:
        """Node：处理不需要企业知识库的请求。"""

        answer = call_service(services, "direct", state["question"])

        return {
            "outcome": "direct",
            "finalAnswer": answer,
            "sourceIds": [],
            "trace": [
                *state.get("trace", []),
                "direct_answer：未查询知识库",
            ],
        }

    def clarify_user(state: AgenticRagState) -> dict[str, Any]:
        """Node：问题缺少用户输入时，返回追问而不是盲目检索。"""

        return {
            "outcome": "clarify",
            "finalAnswer": state.get("clarificationQuestion")
            or "请补充完成判断所需的信息。",
            "sourceIds": [],
            "trace": [
                *state.get("trace", []),
                "clarify_user：缺少用户才能提供的条件",
            ],
        }

    def refuse_answer(state: AgenticRagState) -> dict[str, Any]:
        """Node：证据不足时拒答。"""

        missing = state.get("missingEvidence", [])

        return {
            "outcome": "refused",
            "finalAnswer": f"根据当前知识库资料，无法回答这个问题。缺少证据：{'、'.join(missing)}。",
            "sourceIds": [],
            "trace": [
                *state.get("trace", []),
                "refuse_answer：补查后仍然缺少可用证据",
            ],
        }

    graph_builder = StateGraph(AgenticRagState)

    (
        graph_builder
        .add_node("decide_request", decide_request)
        .add_node("search_knowledge", retrieve_missing_evidence)
        .add_node("assess_evidence", grade_evidence)
        .add_node("generate_answer", generate_answer)
        .add_node("direct_answer", direct_answer)
        .add_node("clarify_user", clarify_user)
        .add_node("refuse_answer", refuse_answer)
        .add_edge(START, "decide_request")
        .add_conditional_edges(
            "decide_request",
            route_after_decision,
            {
                "direct": "direct_answer",
                "clarify": "clarify_user",
                "search": "search_knowledge",
            },
        )
        .add_edge("search_knowledge", "assess_evidence")
        .add_conditional_edges(
            "assess_evidence",
            route_after_assessment,
            {
                "generate": "generate_answer",
                "search": "search_knowledge",
                "refuse": "refuse_answer",
            },
        )
        .add_edge("generate_answer", END)
        .add_edge("direct_answer", END)
        .add_edge("clarify_user", END)
        .add_edge("refuse_answer", END)
    )

    return graph_builder.compile()

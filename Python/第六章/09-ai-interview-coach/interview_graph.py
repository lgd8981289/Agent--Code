"""可恢复、可补查证据的面试 Graph。"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from langgraph.graph import END, START, StateGraph
from typing_extensions import NotRequired, TypedDict

from memory import iso_now
from schemas import InterviewStateView


class GraphState(TypedDict, total=False):
    event: NotRequired[Literal["start", "answer", "next"]]
    sessionId: str
    mode: Literal["replay", "ai"]
    kind: Literal["new", "review"]
    status: NotRequired[Literal["awaiting_answer", "turn_complete"]]
    profile: dict[str, Any]
    messages: NotRequired[list[dict[str, Any]]]
    currentQuestion: NotRequired[dict[str, Any] | None]
    answer: NotRequired[str]
    lastEvaluation: NotRequired[dict[str, Any] | None]
    lastFeedback: NotRequired[dict[str, Any] | None]
    requiredEvidence: NotRequired[list[str]]
    missingEvidence: NotRequired[list[str]]
    evidence: NotRequired[list[dict[str, Any]]]
    usedMemoryKeys: NotRequired[list[str]]
    struggledTopics: NotRequired[list[str]]
    turnNumber: NotRequired[int]
    trace: NotRequired[list[str]]


def message(role: str, kind: str, content: str) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "role": role,
        "kind": kind,
        "content": content,
        "createdAt": iso_now(),
    }


def append_unique(
    items: list[Any],
    additions: list[Any],
    get_key,
) -> list[Any]:
    """按 key 合并列表，并保持原顺序。"""

    result = [*items]
    keys = {get_key(item) for item in items}

    for item in additions:
        key = get_key(item)

        if key not in keys:
            keys.add(key)
            result.append(item)

    return result


def with_defaults(state: dict[str, Any]) -> dict[str, Any]:
    """补齐 Node StateSchema 中原本负责提供的默认值。"""

    return {
        "event": "start",
        "status": "awaiting_answer",
        "messages": [],
        "currentQuestion": None,
        "answer": "",
        "lastEvaluation": None,
        "lastFeedback": None,
        "requiredEvidence": [],
        "missingEvidence": [],
        "evidence": [],
        "usedMemoryKeys": [],
        "struggledTopics": [],
        "turnNumber": 0,
        "trace": [],
        **state,
    }


class InterviewGraphService:
    """将一场面试组装成 LangGraph Workflow。"""

    def __init__(self, memories, knowledge, models):
        self.memories = memories
        self.knowledge = knowledge
        self.models = models

    def create_graph(self, principal: dict[str, Any]):
        def dispatch(state: GraphState) -> dict[str, Any]:
            return {}

        def route_event(state: GraphState) -> Literal["prepare_question", "evaluate_answer"]:
            """根据当前事件决定下一步执行哪个节点。"""

            if state.get("event") == "answer":
                return "evaluate_answer"

            return "prepare_question"

        def prepare_question(state: GraphState) -> dict[str, Any]:
            """Node：准备本轮面试题。"""

            review_memory = (
                self.memories.get_review_memory(principal)
                if state["kind"] == "review"
                else None
            )

            question = self.models.select_question(
                {
                    "profile": state["profile"],
                    "reviewMemory": review_memory,
                    "turnNumber": state.get("turnNumber", 0),
                    "previousQuestion": state.get("currentQuestion"),
                    "previousEvaluation": state.get("lastEvaluation"),
                }
            )

            return {
                # 已经完成出题，等待用户提交答案。
                "status": "awaiting_answer",
                "currentQuestion": question,
                # 新一轮开始后，清空上一轮产生的临时状态。
                "answer": "",
                "lastEvaluation": None,
                "lastFeedback": None,
                "requiredEvidence": [],
                "missingEvidence": [],
                "evidence": [],
                # review 模式会记录本轮使用到的长期记忆 Key。
                "usedMemoryKeys": [review_memory["key"]] if review_memory else [],
                "messages": [
                    *state.get("messages", []),
                    message("assistant", "question", question["prompt"]),
                ],
                "trace": [
                    *state.get("trace", []),
                    (
                        f"prepare_question：根据长期记忆 {review_memory['key']} 生成复测题"
                        if review_memory
                        else f"prepare_question：生成 {question['title']} 面试题"
                    ),
                ],
            }

        def evaluate_answer(state: GraphState) -> dict[str, Any]:
            """Node：评估用户对当前面试题的回答。"""

            current_question = state.get("currentQuestion")

            if not current_question:
                raise RuntimeError("当前会话中没有待回答的题目。")

            answer = state.get("answer", "")

            if not answer.strip():
                raise RuntimeError("面试回答不能为空。")

            evaluation = self.models.evaluate(
                state["mode"],
                current_question,
                answer,
            )

            struggled_topics = (
                state.get("struggledTopics", [])
                if evaluation["verdict"] == "correct"
                else append_unique(
                    state.get("struggledTopics", []),
                    [current_question["topic"]],
                    lambda topic: topic,
                )
            )

            return {
                "lastEvaluation": evaluation,
                "requiredEvidence": evaluation["requiredEvidence"],
                "missingEvidence": evaluation["requiredEvidence"],
                "evidence": [],
                "struggledTopics": struggled_topics,
                "messages": [
                    *state.get("messages", []),
                    message("user", "answer", answer),
                ],
                "trace": [
                    *state.get("trace", []),
                    f"evaluate_answer：{evaluation['verdict']}，需要 {len(evaluation['requiredEvidence'])} 类反馈依据",
                ],
            }

        def route_after_evaluation(state: GraphState) -> Literal["retrieve_evidence", "compose_feedback"]:
            return (
                "retrieve_evidence"
                if len(state.get("missingEvidence", [])) > 0
                else "compose_feedback"
            )

        def retrieve_evidence(state: GraphState) -> dict[str, Any]:
            """Node：根据当前缺失的证据类型补查资料。"""

            evidence_type = state.get("missingEvidence", [None])[0]

            if not evidence_type:
                raise RuntimeError("没有找到本轮需要补查的证据类型。")

            found = self.knowledge.search(evidence_type)

            return {
                "evidence": append_unique(
                    state.get("evidence", []),
                    found,
                    lambda source: source["id"],
                ),
                "trace": [
                    *state.get("trace", []),
                    f"retrieve_evidence：{evidence_type} 返回 {len(found)} 条资料",
                ],
            }

        def assess_evidence(state: GraphState) -> dict[str, Any]:
            found_types = {item["evidenceType"] for item in state.get("evidence", [])}
            missing_evidence = [
                evidence_type
                for evidence_type in state.get("requiredEvidence", [])
                if evidence_type not in found_types
            ]

            return {
                "missingEvidence": missing_evidence,
                "trace": [
                    *state.get("trace", []),
                    (
                        f"assess_evidence：仍缺少 {'、'.join(missing_evidence)}"
                        if missing_evidence
                        else "assess_evidence：反馈依据已经齐全"
                    ),
                ],
            }

        def route_after_assessment(state: GraphState) -> Literal["retrieve_evidence", "compose_feedback"]:
            return (
                "retrieve_evidence"
                if len(state.get("missingEvidence", [])) > 0
                else "compose_feedback"
            )

        def compose_feedback(state: GraphState) -> dict[str, Any]:
            if not state.get("currentQuestion") or not state.get("lastEvaluation"):
                raise RuntimeError("缺少面试题或评估结果。")

            feedback = self.models.compose_feedback(
                {
                    "mode": state["mode"],
                    "question": state["currentQuestion"],
                    "answer": state.get("answer", ""),
                    "evaluation": state["lastEvaluation"],
                    "evidence": state.get("evidence", []),
                }
            )

            return {
                "status": "turn_complete",
                "lastFeedback": feedback,
                "turnNumber": state.get("turnNumber", 0) + 1,
                "messages": [
                    *state.get("messages", []),
                    message("assistant", "feedback", feedback["content"]),
                ],
                "trace": [
                    *state.get("trace", []),
                    f"compose_feedback：绑定 {len(feedback['sourceIds'])} 条真实来源",
                ],
            }

        def save_training_memory(state: GraphState) -> dict[str, Any]:
            """Node：将本次答题结果写入训练记忆。"""

            if (
                not state.get("currentQuestion")
                or not state.get("lastEvaluation")
                or not state.get("lastFeedback")
            ):
                raise RuntimeError("缺少可供保存的答题结果。")

            saved = self.memories.record_training_result(
                principal,
                {
                    "topic": state["currentQuestion"]["topic"],
                    "title": state["currentQuestion"]["title"],
                    "verdict": state["lastEvaluation"]["verdict"],
                    "answerSummary": state.get("answer", ""),
                    "questionId": state["currentQuestion"]["id"],
                    "sourceIds": state["lastFeedback"]["sourceIds"],
                    "struggled": state["currentQuestion"]["topic"]
                    in state.get("struggledTopics", []),
                },
            )

            return {
                "trace": [
                    *state.get("trace", []),
                    (
                        f"save_memory：{saved['key']} 更新为 {saved['status']}"
                        if saved
                        else f"save_memory：{state['currentQuestion']['topic']} 已被用户禁止自动保存"
                    ),
                ],
            }

        graph_builder = StateGraph(GraphState)

        (
            graph_builder
            .add_node("dispatch", dispatch)
            .add_node("prepare_question", prepare_question)
            .add_node("evaluate_answer", evaluate_answer)
            .add_node("retrieve_evidence", retrieve_evidence)
            .add_node("assess_evidence", assess_evidence)
            .add_node("compose_feedback", compose_feedback)
            .add_node("save_memory", save_training_memory)
            .add_edge(START, "dispatch")
            .add_conditional_edges(
                "dispatch",
                route_event,
                {
                    "prepare_question": "prepare_question",
                    "evaluate_answer": "evaluate_answer",
                },
            )
            .add_conditional_edges(
                "evaluate_answer",
                route_after_evaluation,
                {
                    "retrieve_evidence": "retrieve_evidence",
                    "compose_feedback": "compose_feedback",
                },
            )
            .add_edge("retrieve_evidence", "assess_evidence")
            .add_conditional_edges(
                "assess_evidence",
                route_after_assessment,
                {
                    "retrieve_evidence": "retrieve_evidence",
                    "compose_feedback": "compose_feedback",
                },
            )
            .add_edge("compose_feedback", "save_memory")
            .add_edge("prepare_question", END)
            .add_edge("save_memory", END)
        )

        return graph_builder.compile()

    def invoke(
        self,
        principal: dict[str, Any],
        session_id: str,
        input_data: dict[str, Any],
    ) -> dict[str, Any]:
        """执行当前用户对应的 Agent Graph。

        sessionId 与 Graph State 一一对应。
        再次 invoke 时，先恢复旧状态，再合并本次事件输入。
        """

        current = self.memories.get_graph_state(principal, session_id) or {}
        merged = with_defaults({**current, **input_data, "sessionId": session_id})
        state = self.create_graph(principal).invoke(merged)
        self.memories.save_graph_state(principal, session_id, state)
        return state

    def get_state(
        self,
        principal: dict[str, Any],
        session_id: str,
    ) -> dict[str, Any]:
        """获取指定面试 Session 当前保存的 Graph State。"""

        return self.memories.get_graph_state(principal, session_id) or {}

    def to_view(self, state: dict[str, Any]) -> dict[str, Any]:
        """将内部 Graph State 转换成前端可以直接消费的 View Model。"""

        return InterviewStateView(
            sessionId=state["sessionId"],
            mode=state["mode"],
            kind=state["kind"],
            status=state["status"],
            profile=state["profile"],
            messages=state.get("messages", []),
            currentQuestion=state.get("currentQuestion"),
            lastEvaluation=state.get("lastEvaluation"),
            lastFeedback=state.get("lastFeedback"),
            evidence=state.get("evidence", []),
            usedMemoryKeys=state.get("usedMemoryKeys", []),
            turnNumber=state.get("turnNumber", 0),
            trace=state.get("trace", []),
        ).model_dump()

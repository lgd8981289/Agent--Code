"""用户画像、训练记录、记忆阻断和会话索引管理。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from schemas import InterviewProfile, LearningMemory, SessionSummary


def profile_namespace(principal: dict[str, Any]) -> list[str]:
    return [principal["tenantId"], principal["userId"], "profile"]


def learning_namespace(principal: dict[str, Any]) -> list[str]:
    return [principal["tenantId"], principal["userId"], "learning-memories"]


def session_namespace(principal: dict[str, Any]) -> list[str]:
    return [principal["tenantId"], principal["userId"], "interview-sessions"]


def block_namespace(principal: dict[str, Any]) -> list[str]:
    return [principal["tenantId"], principal["userId"], "memory-blocks"]


def graph_state_namespace(principal: dict[str, Any]) -> list[str]:
    """保存可恢复 Graph State 的命名空间。

    Node 版通过 LangGraph Checkpointer 按 thread_id 保存状态。
    Python 版在教学上显式保存 Graph State，更容易看清 sessionId 和状态恢复的关系。
    """

    return [principal["tenantId"], principal["userId"], "graph-states"]


def default_profile(principal: dict[str, Any]) -> dict[str, Any]:
    if principal["userId"] == "user-chenzhou":
        return InterviewProfile(
            experience="2 年 Node.js 后端开发",
            targetRole="Agent 后端开发工程师",
            focusTopics=["Agent Runtime", "Tool Calling", "RAG"],
            answerStyle="先让我完整回答，再给出具体反馈",
        ).model_dump()

    return InterviewProfile(
        experience="3 年前端开发",
        targetRole="AI 应用开发工程师",
        focusTopics=["Agent Memory", "RAG", "LangGraph"],
        answerStyle="一次只问一道题，回答后再继续追问",
    ).model_dump()


def iso_now() -> str:
    """生成接近 JavaScript Date.toISOString() 的 UTC 时间字符串。"""

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def add_days(value: datetime, days: int) -> str:
    return (value + timedelta(days=days)).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


class InterviewMemoryService:
    """管理跨会话长期记忆。"""

    def __init__(self, storage):
        self.storage = storage

    def get_profile(self, principal: dict[str, Any]) -> dict[str, Any]:
        namespace = profile_namespace(principal)
        item = self.storage.get(namespace, "current")

        if item:
            return item.value

        profile = default_profile(principal)
        self.storage.put(namespace, "current", dict(profile))
        return profile

    def update_profile(
        self,
        principal: dict[str, Any],
        patch: dict[str, Any],
    ) -> dict[str, Any]:
        """更新当前用户的面试训练画像。

        采用“读取当前值 + 局部覆盖”的方式更新，
        未出现在 patch 中的字段会继续保留原值。
        """

        current = self.get_profile(principal)

        next_profile = {
            **current,
            **patch,
            # focusTopics 没有传入时继续保留原值，避免被 None 意外覆盖。
            "focusTopics": patch.get("focusTopics") or current["focusTopics"],
        }

        validated = InterviewProfile(**next_profile).model_dump()
        self.storage.put(profile_namespace(principal), "current", dict(validated))
        return validated

    def list_learning_memories(self, principal: dict[str, Any]) -> list[dict[str, Any]]:
        items = self.storage.search(learning_namespace(principal), limit=100)
        memories = [LearningMemory(**item.value).model_dump() for item in items]

        # 保持 Node 版排序：
        # 先按状态 needs_review → improving → mastered，
        # 同状态下按 updatedAt 倒序。
        order = {
            "needs_review": 0,
            "improving": 1,
            "mastered": 2,
        }
        memories.sort(key=lambda memory: memory["updatedAt"], reverse=True)
        memories.sort(key=lambda memory: order[memory["status"]])
        return memories

    def get_review_memory(self, principal: dict[str, Any]) -> dict[str, Any] | None:
        """获取当前最适合用于复测的长期学习记忆。"""

        memories = self.list_learning_memories(principal)

        return next(
            (memory for memory in memories if memory["status"] == "needs_review"),
            None,
        ) or next(
            (memory for memory in memories if memory["status"] == "improving"),
            None,
        )

    def record_training_result(
        self,
        principal: dict[str, Any],
        input_data: dict[str, Any],
    ) -> dict[str, Any] | None:
        """把本轮答题结果写入长期训练记忆。"""

        key = input_data["topic"]
        blocked = self.storage.get(block_namespace(principal), key)

        if blocked:
            return None

        namespace = learning_namespace(principal)
        existing_item = self.storage.get(namespace, key)
        existing = existing_item.value if existing_item else None
        now = datetime.now(UTC)

        correct_count = (existing["correctCount"] if existing else 0) + (
            1 if input_data["verdict"] == "correct" else 0
        )

        if input_data["verdict"] != "correct":
            status = "needs_review"
        elif input_data["struggled"] or (existing and existing["status"] == "needs_review"):
            status = "improving"
        else:
            status = "mastered"

        review_after_days = 1 if status == "needs_review" else 3 if status == "improving" else 14

        memory = LearningMemory(
            key=key,
            topic=input_data["topic"],
            title=input_data["title"],
            status=status,
            attempts=(existing["attempts"] if existing else 0) + 1,
            correctCount=correct_count,
            lastVerdict=input_data["verdict"],
            lastAnswerSummary=input_data["answerSummary"][:180],
            lastQuestionId=input_data["questionId"],
            sourceIds=input_data["sourceIds"],
            updatedAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            nextReviewAt=add_days(now, review_after_days),
        ).model_dump()

        self.storage.put(namespace, key, dict(memory))
        return memory

    def forget_learning_memory(self, principal: dict[str, Any], key: str) -> None:
        """删除指定训练记忆，并阻止后台再次自动保存同一主题。"""

        self.storage.put(
            block_namespace(principal),
            key,
            {
                "blockedAt": iso_now(),
            },
        )
        self.storage.delete(learning_namespace(principal), key)

    def save_session(
        self,
        principal: dict[str, Any],
        session: dict[str, Any],
    ) -> dict[str, Any]:
        validated = SessionSummary(**session).model_dump()
        self.storage.put(session_namespace(principal), validated["id"], dict(validated))
        return validated

    def get_session(
        self,
        principal: dict[str, Any],
        session_id: str,
    ) -> dict[str, Any] | None:
        item = self.storage.get(session_namespace(principal), session_id)
        return SessionSummary(**item.value).model_dump() if item else None

    def list_sessions(self, principal: dict[str, Any]) -> list[dict[str, Any]]:
        items = self.storage.search(session_namespace(principal), limit=100)
        sessions = [SessionSummary(**item.value).model_dump() for item in items]
        sessions.sort(key=lambda session: session["updatedAt"], reverse=True)
        return sessions

    def save_graph_state(
        self,
        principal: dict[str, Any],
        session_id: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        self.storage.put(graph_state_namespace(principal), session_id, dict(state))
        return state

    def get_graph_state(
        self,
        principal: dict[str, Any],
        session_id: str,
    ) -> dict[str, Any] | None:
        item = self.storage.get(graph_state_namespace(principal), session_id)
        return dict(item.value) if item else None

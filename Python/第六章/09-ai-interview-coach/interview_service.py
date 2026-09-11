"""HTTP 操作和面试 Graph 之间的业务编排层。"""

from __future__ import annotations

import os
import uuid
from typing import Any

from memory import InterviewMemoryService, iso_now
from schemas import InterviewProfile, SessionKind, SessionMode, SessionSummary


class InterviewService:
    """将 HTTP 请求转换成会话、Graph 和长期记忆操作。"""

    def __init__(self, graph, memories: InterviewMemoryService, models):
        self.graph = graph
        self.memories = memories
        self.models = models

    def capabilities(self) -> dict[str, Any]:
        return {
            "replay": True,
            "ai": self.models.has_ai_mode(),
            "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        }

    def create_session(
        self,
        principal: dict[str, Any],
        input_data: dict[str, Any],
    ) -> dict[str, Any]:
        """创建一个新的面试 Session，并启动对应的 Agent Graph。"""

        kind: SessionKind = input_data.get("kind") or "new"
        mode: SessionMode = input_data.get("mode") or "replay"

        if mode == "ai" and not self.models.has_ai_mode():
            raise ValueError("AI 模式需要配置 DEEPSEEK_API_KEY。")

        profile = self.memories.get_profile(principal)
        session_id = str(uuid.uuid4())
        current_time = iso_now()

        session = SessionSummary(
            id=session_id,
            title="薄弱点专项复测" if kind == "review" else f"{profile['targetRole']}专项面试",
            status="awaiting_answer",
            topic="待复测" if kind == "review" else (profile["focusTopics"][0] if profile["focusTopics"] else "Agent"),
            mode=mode,
            kind=kind,
            turnNumber=0,
            createdAt=current_time,
            updatedAt=current_time,
        ).model_dump()

        self.memories.save_session(principal, session)

        state = self.graph.invoke(
            principal,
            session_id,
            {
                "event": "start",
                "sessionId": session_id,
                "mode": mode,
                "kind": kind,
                "profile": profile,
            },
        )

        self.sync_session(principal, session, state)
        return self.graph.to_view(state)

    def get_session(
        self,
        principal: dict[str, Any],
        session_id: str,
    ) -> dict[str, Any]:
        self.require_session(principal, session_id)
        state = self.graph.get_state(principal, session_id)

        if not state.get("sessionId"):
            raise LookupError("会话状态不存在。")

        return self.graph.to_view(state)

    def answer(
        self,
        principal: dict[str, Any],
        session_id: str,
        answer: str,
    ) -> dict[str, Any]:
        """处理用户提交的当前题目回答，并继续推进面试流程。"""

        session = self.require_session(principal, session_id)
        current = self.graph.get_state(principal, session_id)

        if current.get("status") != "awaiting_answer":
            raise ValueError("当前没有等待回答的题目。")

        if not answer or not answer.strip():
            raise ValueError("回答不能为空。")

        state = self.graph.invoke(
            principal,
            session_id,
            {
                "event": "answer",
                "answer": answer.strip(),
            },
        )

        self.sync_session(principal, session, state)
        return self.graph.to_view(state)

    def next(
        self,
        principal: dict[str, Any],
        session_id: str,
    ) -> dict[str, Any]:
        session = self.require_session(principal, session_id)
        current = self.graph.get_state(principal, session_id)

        if current.get("status") != "turn_complete":
            raise ValueError("请先完成当前题目。")

        state = self.graph.invoke(
            principal,
            session_id,
            {
                "event": "next",
            },
        )

        self.sync_session(principal, session, state)
        return self.graph.to_view(state)

    def require_session(
        self,
        principal: dict[str, Any],
        session_id: str,
    ) -> dict[str, Any]:
        session = self.memories.get_session(principal, session_id)

        if not session:
            raise PermissionError("会话不存在，或当前用户无权访问。")

        return session

    def sync_session(
        self,
        principal: dict[str, Any],
        session: dict[str, Any],
        state: dict[str, Any],
    ) -> None:
        """把 Graph 最新状态同步回 Session 摘要。"""

        self.memories.save_session(
            principal,
            {
                **session,
                "status": state["status"],
                "topic": state["currentQuestion"]["title"]
                if state.get("currentQuestion")
                else session["topic"],
                "turnNumber": state.get("turnNumber", 0),
                "updatedAt": iso_now(),
            },
        )


def normalize_profile_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """校验并规范化前端提交的画像补丁。"""

    allowed = {
        "experience",
        "targetRole",
        "focusTopics",
        "answerStyle",
    }
    cleaned = {key: value for key, value in patch.items() if key in allowed}

    if "focusTopics" in cleaned and isinstance(cleaned["focusTopics"], str):
        cleaned["focusTopics"] = [
            item.strip()
            for item in cleaned["focusTopics"].replace("，", "、").split("、")
            if item.strip()
        ]

    # 这里只做字段级清洗，最终完整结构由 memory.update_profile 使用 InterviewProfile 校验。
    return cleaned

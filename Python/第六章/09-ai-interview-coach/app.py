"""FastAPI 版 AI 面试教练应用。"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from auth import demo_users, get_current_principal
from interview_graph import InterviewGraphService
from interview_service import InterviewService, normalize_profile_patch
from knowledge import InterviewKnowledgeService
from memory import InterviewMemoryService
from model_service import InterviewModelService
from storage import create_storage


class SessionInput(BaseModel):
    kind: str | None = None
    mode: str | None = None


class AnswerInput(BaseModel):
    answer: str


def create_app(storage=None) -> FastAPI:
    """创建应用实例。

    测试可以传入 InMemoryStore；
    真实启动时默认使用 PostgreSQL Store。
    """

    store = storage or create_storage()
    memories = InterviewMemoryService(store)
    knowledge = InterviewKnowledgeService()
    models = InterviewModelService()
    graph = InterviewGraphService(memories, knowledge, models)
    interviews = InterviewService(graph, memories, models)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        store.setup()
        try:
            yield
        finally:
            store.close()

    app = FastAPI(title="AI 面试教练 Agent", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "service": "ai-interview-coach",
        }

    @app.get("/api/users")
    def users() -> list[dict[str, Any]]:
        return [dict(user) for user in demo_users]

    @app.get("/api/capabilities")
    def capabilities(
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        return interviews.capabilities()

    @app.get("/api/profile")
    def profile(
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        return memories.get_profile(principal)

    @app.patch("/api/profile")
    def update_profile(
        patch: dict[str, Any],
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        try:
            return memories.update_profile(
                principal,
                normalize_profile_patch(patch),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/memories")
    def memories_endpoint(
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> list[dict[str, Any]]:
        return memories.list_learning_memories(principal)

    @app.delete("/api/memories/{key}")
    def delete_memory(
        key: str,
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        memories.forget_learning_memory(principal, key)
        return {
            "deleted": True,
            "key": key,
        }

    @app.get("/api/sessions")
    def sessions(
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> list[dict[str, Any]]:
        return memories.list_sessions(principal)

    @app.post("/api/sessions")
    def create_session(
        input_data: SessionInput,
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        try:
            return interviews.create_session(
                principal,
                input_data.model_dump(exclude_none=True),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/sessions/{session_id}")
    def get_session(
        session_id: str,
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        try:
            return interviews.get_session(principal, session_id)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/sessions/{session_id}/answers")
    def answer(
        session_id: str,
        input_data: AnswerInput,
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        try:
            return interviews.answer(
                principal,
                session_id,
                input_data.answer,
            )
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/sessions/{session_id}/next")
    def next_question(
        session_id: str,
        principal: dict[str, Any] = Depends(get_current_principal),
    ) -> dict[str, Any]:
        try:
            return interviews.next(principal, session_id)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    static_dir = Path(__file__).resolve().parent / "static"
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app


app = create_app()

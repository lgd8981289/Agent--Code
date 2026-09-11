"""AI 面试教练项目的数据结构。

字段名保留 Node 版本的 camelCase，
这样前端 API、课程截图和接口语义可以保持一致。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


SessionMode = Literal["replay", "ai"]
SessionKind = Literal["new", "review"]
SessionStatus = Literal["awaiting_answer", "turn_complete"]
Verdict = Literal["correct", "partial", "incorrect"]


class InterviewProfile(BaseModel):
    experience: str
    targetRole: str
    focusTopics: list[str]
    answerStyle: str


class InterviewMessage(BaseModel):
    id: str
    role: Literal["assistant", "user"]
    kind: Literal["question", "answer", "feedback"]
    content: str
    createdAt: str


class InterviewQuestion(BaseModel):
    id: str
    topic: str
    title: str
    prompt: str
    expectedPoints: list[str]
    evidenceTypes: list[str]
    followUpPrompt: str


class EvaluationResult(BaseModel):
    verdict: Verdict
    reason: str
    gaps: list[str]
    requiredEvidence: list[str]


class KnowledgeSource(BaseModel):
    id: str
    evidenceType: str
    title: str
    content: str
    url: str


class FeedbackResult(BaseModel):
    content: str
    sourceIds: list[str]


class LearningMemory(BaseModel):
    key: str
    topic: str
    title: str
    status: Literal["needs_review", "improving", "mastered"]
    attempts: int = Field(ge=0)
    correctCount: int = Field(ge=0)
    lastVerdict: Verdict
    lastAnswerSummary: str
    lastQuestionId: str
    sourceIds: list[str]
    updatedAt: str
    nextReviewAt: str


class SessionSummary(BaseModel):
    id: str
    title: str
    status: SessionStatus
    topic: str
    mode: SessionMode
    kind: SessionKind
    turnNumber: int = Field(ge=0)
    createdAt: str
    updatedAt: str


class InterviewStateView(BaseModel):
    sessionId: str
    mode: SessionMode
    kind: SessionKind
    status: SessionStatus
    profile: InterviewProfile
    messages: list[InterviewMessage]
    currentQuestion: InterviewQuestion | None
    lastEvaluation: EvaluationResult | None
    lastFeedback: FeedbackResult | None
    evidence: list[KnowledgeSource]
    usedMemoryKeys: list[str]
    turnNumber: int
    trace: list[str]


class Capabilities(BaseModel):
    replay: bool
    ai: bool
    model: str


def to_plain(value):
    """把 Pydantic Model 或普通对象统一转成可 JSON 化的 dict/list。"""

    if isinstance(value, BaseModel):
        return value.model_dump()

    if isinstance(value, list):
        return [to_plain(item) for item in value]

    if isinstance(value, dict):
        return {key: to_plain(item) for key, item in value.items()}

    return value

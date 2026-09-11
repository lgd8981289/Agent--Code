"""面试题选择、Replay 评估和真实模型调用。"""

from __future__ import annotations

import json
import os
from typing import Any

from pydantic import BaseModel

from schemas import EvaluationResult, FeedbackResult, InterviewQuestion, SessionMode


question_bank: list[dict[str, Any]] = [
    {
        "id": "memory-boundaries",
        "topic": "agent-memory",
        "title": "短期记忆与长期记忆",
        "prompt": "在 LangGraph 中，Checkpointer 和 Store 有什么区别？如果希望用户换一个 Thread 后仍能复习薄弱知识点，应该保存在哪里？",
        "expectedPoints": [
            "Checkpointer 按 thread_id 保存当前 Thread 的 Agent State",
            "Store 使用自定义 Namespace 保存跨 Thread 的长期信息",
            "跨会话复习的薄弱点应该保存在 Store 中",
        ],
        "evidenceTypes": ["short_term_memory", "long_term_memory"],
        "followUpPrompt": "同一名用户关闭页面后继续原面试，以及新建一场复习面试，分别应该从 Checkpointer 和 Store 中读取什么？",
    },
    {
        "id": "agentic-rag",
        "topic": "agentic-rag",
        "title": "Agentic RAG",
        "prompt": "普通 RAG 和 Agentic RAG 的主要区别是什么？什么情况下 Agent 需要进行第二轮检索？",
        "expectedPoints": [
            "普通 RAG 的检索流程通常由程序预先固定",
            "Agentic RAG 会根据任务决定是否检索和检索什么",
            "必要证据缺失时才继续补查，并且需要检索预算",
        ],
        "evidenceTypes": ["agentic_rag"],
        "followUpPrompt": "如果第一轮只找到人工审核阈值，却没有找到材料要求，Agent 接下来应该怎样处理？",
    },
    {
        "id": "tool-calling",
        "topic": "tool-calling",
        "title": "Tool Calling",
        "prompt": "模型返回 Tool Call 以后，为什么不能认为工具已经执行完成？",
        "expectedPoints": [
            "模型只提出工具名称和参数",
            "应用程序负责校验和执行",
            "工具结果需要回传给模型继续处理",
        ],
        "evidenceTypes": ["tool_calling"],
        "followUpPrompt": "如果 Tool Call 中的订单号不存在，应用程序应该把什么结果回传给模型？",
    },
    {
        "id": "context-budget",
        "topic": "context-budget",
        "title": "Context Budget",
        "prompt": "长对话中，应用程序为什么需要主动管理 Context Budget？",
        "expectedPoints": [
            "上下文窗口存在上限",
            "输入 Token 会影响成本和延迟",
            "应该优先保留完成当前任务需要的信息",
        ],
        "evidenceTypes": ["context_budget"],
        "followUpPrompt": "当历史消息超过预算时，哪些信息应该优先保留，哪些内容可以被裁剪或摘要？",
    },
]


class FeedbackSchema(BaseModel):
    content: str
    sourceIds: list[str]


def contains_any(answer: str, words: list[str]) -> bool:
    """判断回答中是否包含某组关键表达中的任意一个。"""

    normalized = answer.lower()
    return any(word.lower() in normalized for word in words)


def create_replay_evaluation(
    question: dict[str, Any],
    answer: str,
) -> dict[str, Any]:
    """Replay 模式下的确定性评估规则。

    这里故意不用模型，而是用固定关键词模拟面试官判断。
    这样课程演示可以稳定复现，不依赖 API Key。
    """

    rules: dict[str, list[list[str]]] = {
        "agent-memory": [
            ["thread", "thread_id", "会话"],
            ["store", "跨会话", "长期记忆"],
            ["checkpointer", "state", "状态"],
        ],
        "agentic-rag": [
            ["是否检索", "按需", "自主"],
            ["证据", "缺少", "不足"],
            ["补查", "第二轮", "多轮"],
        ],
        "tool-calling": [
            ["模型", "提出", "生成"],
            ["应用", "程序", "执行"],
            ["回传", "tool result", "toolmessage"],
        ],
        "context-budget": [
            ["上限", "窗口"],
            ["token", "成本", "延迟"],
            ["保留", "裁剪", "摘要"],
        ],
    }

    matched = sum(
        1
        for group in rules.get(question["topic"], [])
        if contains_any(answer, group)
    )
    verdict = "correct" if matched >= 3 else "partial" if matched >= 1 else "incorrect"
    gaps = question["expectedPoints"][matched:]

    return EvaluationResult(
        verdict=verdict,
        reason=(
            "回答覆盖了这道题的核心边界。"
            if verdict == "correct"
            else "已经提到部分相关概念，但关键区别还没有说完整。"
        ),
        gaps=gaps,
        requiredEvidence=question["evidenceTypes"],
    ).model_dump()


def normalize_structured(value: Any, schema: type[BaseModel]) -> dict[str, Any]:
    """把 LangChain Structured Output 结果统一转换成 dict。"""

    if isinstance(value, BaseModel):
        return value.model_dump()

    return schema.model_validate(value).model_dump()


class InterviewModelService:
    """封装确定性演示与真实 DeepSeek 两种面试能力。"""

    def create_model(self):
        """创建真实模型。Replay 模式不会走到这里。"""

        if not os.getenv("DEEPSEEK_API_KEY"):
            raise RuntimeError("当前未配置 DEEPSEEK_API_KEY，请使用 Replay 模式。")

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
            timeout=60,
            model_kwargs={
                "thinking": {"type": "disabled"},
            },
        )

    def has_ai_mode(self) -> bool:
        return bool(os.getenv("DEEPSEEK_API_KEY"))

    def select_question(self, input_data: dict[str, Any]) -> dict[str, Any]:
        """根据画像、长期记忆和上一轮结果选择下一道题。"""

        previous_question = input_data.get("previousQuestion")
        previous_evaluation = input_data.get("previousEvaluation")

        if (
            previous_question
            and (not previous_evaluation or previous_evaluation.get("verdict") != "correct")
            and not previous_question["id"].endswith("-followup")
        ):
            return {
                **previous_question,
                "id": f"{previous_question['id']}-followup",
                "prompt": previous_question["followUpPrompt"],
            }

        review_memory = input_data.get("reviewMemory")

        if review_memory:
            reviewed = next(
                (
                    question
                    for question in question_bank
                    if question["topic"] == review_memory.get("topic")
                ),
                None,
            )

            if reviewed:
                return {
                    **reviewed,
                    "id": f"{reviewed['id']}-review",
                    "prompt": f"上次你在「{reviewed['title']}」上留下了薄弱记录。这次换一个场景：{reviewed['followUpPrompt']}",
                }

        profile = input_data["profile"]
        topic_text = " ".join(profile["focusTopics"]).lower()
        preferred_index = 0 if "memory" in topic_text else 1
        turn_number = input_data.get("turnNumber", 0)

        return dict(question_bank[(preferred_index + turn_number) % len(question_bank)])

    def evaluate(
        self,
        mode: SessionMode,
        question: dict[str, Any],
        answer: str,
    ) -> dict[str, Any]:
        """评估当前回答质量。"""

        if mode == "replay":
            return create_replay_evaluation(question, answer)

        evaluator = self.create_model().with_structured_output(EvaluationResult)
        result = evaluator.invoke(
            [
                {
                    "role": "system",
                    "content": "你是 AI 应用开发岗位的面试官。严格对照 expectedPoints 评估回答，不要因为候选人提到相关名词就判定正确。requiredEvidence 只能从题目提供的 evidenceTypes 中选择。",
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "question": question,
                            "answer": answer,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                },
            ]
        )

        normalized = normalize_structured(result, EvaluationResult)
        required_evidence = [
            evidence_type
            for evidence_type in normalized["requiredEvidence"]
            if evidence_type in question["evidenceTypes"]
        ]

        return {
            **normalized,
            "requiredEvidence": required_evidence
            if required_evidence
            else question["evidenceTypes"],
        }

    def compose_feedback(self, input_data: dict[str, Any]) -> dict[str, Any]:
        """根据评估结果和课程依据生成反馈。"""

        if input_data["mode"] == "replay":
            gaps = input_data["evaluation"]["gaps"]
            missing = f"\n\n还需要补充：{'；'.join(gaps)}。" if gaps else ""

            return FeedbackResult(
                content=(
                    f"{input_data['evaluation']['reason']}"
                    f"{missing}\n\n"
                    f"一个完整回答应该包含：{'；'.join(input_data['question']['expectedPoints'])}。"
                ),
                sourceIds=[source["id"] for source in input_data["evidence"]],
            ).model_dump()

        writer = self.create_model().with_structured_output(FeedbackSchema)
        response = writer.invoke(
            [
                {
                    "role": "system",
                    "content": "根据评估结果和已检索的资料，给候选人一段直接、可执行的面试反馈。sourceIds 只能填写输入中真实存在的资料 ID。",
                },
                {
                    "role": "user",
                    "content": json.dumps(input_data, ensure_ascii=False, indent=2),
                },
            ]
        )

        normalized = normalize_structured(response, FeedbackSchema)
        allowed_ids = {source["id"] for source in input_data["evidence"]}

        return {
            "content": normalized["content"],
            "sourceIds": [
                source_id
                for source_id in normalized["sourceIds"]
                if source_id in allowed_ids
            ],
        }

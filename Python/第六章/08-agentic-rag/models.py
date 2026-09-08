"""模型服务封装。

本节把模型调用集中放在这个文件里：

- decide：让模型判断本轮请求是直接回答、检索知识库，还是向用户追问；
- direct：处理不需要企业知识库的普通文本任务；
- answer：基于已经通过校验的证据生成带来源的答案。

workflow.py 只依赖这三个能力，不直接关心具体模型厂商。
"""

from __future__ import annotations

import os
from typing import Any, Literal

from pydantic import BaseModel, Field


EvidenceType = Literal[
    "review_rule",
    "material_requirement",
    "arrival_rule",
    "maintenance_policy",
]


class RetrievalDecision(BaseModel):
    """模型对本轮请求的路由决策。"""

    route: Literal["direct", "retrieve", "clarify"]
    requiredEvidence: list[EvidenceType] = Field(default_factory=list)
    clarificationQuestion: str | None = None
    reason: str = Field(min_length=1)


class GroundedAnswer(BaseModel):
    """模型基于证据生成的最终回答。"""

    answer: str = Field(min_length=1)
    sourceIds: list[str] = Field(min_length=1)


def create_model() -> Any:
    """创建本示例统一使用的 DeepSeek Chat Model。"""

    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先加载你已有的环境变量。")

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


def read_text(content: Any) -> str:
    """兼容不同模型返回的 content 结构。"""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        texts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return "\n".join(texts)

    return "" if content is None else str(content)


def normalize_structured_output(value: Any, schema: type[BaseModel]) -> dict[str, Any]:
    """把 LangChain Structured Output 结果统一转换成 dict。"""

    if isinstance(value, BaseModel):
        return value.model_dump()

    return schema.model_validate(value).model_dump()


class ModelServices:
    """供 Workflow 调用的模型服务集合。"""

    def __init__(self, model: Any | None = None):
        self.model = model or create_model()
        self.decision_model = self.model.with_structured_output(RetrievalDecision)
        self.answer_model = self.model.with_structured_output(GroundedAnswer)

    def decide(self, question: str) -> dict[str, Any]:
        """判断本轮问题应该如何处理。"""

        result = self.decision_model.invoke(
            [
                {
                    "role": "system",
                    "content": """你是企业售后知识库入口决策器。

你只能在三种路线中选择一种：
1. direct：用户只是让你改写、总结、翻译、格式化文本，不需要企业知识库。
2. clarify：用户问题缺少必须由用户补充的信息，例如没有给出退款金额、订单号或商品类型。
3. retrieve：需要查询企业知识库才能回答。

如果选择 retrieve，你必须列出需要的证据类型：
- review_rule：退款金额是否需要人工审核。
- material_requirement：申请退款需要提交哪些材料。
- arrival_rule：退款到账时间。
- maintenance_policy：咖啡机保养政策。

不要因为问题里出现企业名称就必然检索。
不要生成最终答案，只返回结构化决策。""",
                },
                {
                    "role": "user",
                    "content": question,
                },
            ]
        )

        return normalize_structured_output(result, RetrievalDecision)

    def direct(self, question: str) -> str:
        """回答不需要企业知识库的普通文本任务。"""

        response = self.model.invoke(
            [
                {
                    "role": "system",
                    "content": "完成不依赖企业知识的文字处理任务。不要声称查询过知识库。回答简洁。",
                },
                {
                    "role": "user",
                    "content": question,
                },
            ]
        )

        return read_text(getattr(response, "content", response))

    def answer(self, payload: dict[str, Any]) -> dict[str, Any]:
        """基于已经通过校验的资料生成可溯源答案。"""

        question = payload["question"]
        evidence = payload["evidence"]
        evidence_text = "\n\n".join(
            [
                f"[{chunk['id']}] {chunk['title']}\n"
                f"类型：{chunk['evidenceType']}\n"
                f"内容：{chunk['content']}"
                for chunk in evidence
            ]
        )

        result = self.answer_model.invoke(
            [
                {
                    "role": "system",
                    "content": """你是企业售后知识库问答助手。

必须只根据给定资料回答。
如果答案使用了某条资料，sourceIds 必须填写对应 Chunk ID。
sourceIds 只能来自给定资料，不得编造。
不要引用没有出现在资料里的政策。""",
                },
                {
                    "role": "user",
                    "content": f"用户问题：{question}\n\n可用资料：\n{evidence_text}",
                },
            ]
        )

        return normalize_structured_output(result, GroundedAnswer)


def create_model_services() -> ModelServices:
    """创建 Workflow 所需的模型服务。"""

    return ModelServices()

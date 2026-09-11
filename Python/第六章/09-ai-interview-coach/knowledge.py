"""面试反馈依据知识库。

这里用内存数组模拟课程资料库。
Graph 每次只补查一种 evidenceType，
从而展示“缺什么证据，再查什么证据”的 Agentic RAG 流程。
"""

from __future__ import annotations

from schemas import KnowledgeSource


sources: list[KnowledgeSource] = [
    KnowledgeSource(
        id="LC-SHORT-TERM-MEMORY",
        evidenceType="short_term_memory",
        title="LangChain Short-term memory",
        content="短期记忆属于 Thread-scoped State。Checkpointer 按 thread_id 保存 Agent State，使同一个 Thread 能够在后续调用中恢复。",
        url="https://docs.langchain.com/oss/javascript/langchain/short-term-memory",
    ),
    KnowledgeSource(
        id="LC-LONG-TERM-MEMORY",
        evidenceType="long_term_memory",
        title="LangChain Long-term memory",
        content="长期记忆通过 Store 保存，可以使用自定义 Namespace 按租户和用户组织数据，并在不同 Thread 之间共享。",
        url="https://docs.langchain.com/oss/javascript/langchain/long-term-memory",
    ),
    KnowledgeSource(
        id="LG-PERSISTENCE",
        evidenceType="persistence",
        title="LangGraph Persistence",
        content="LangGraph Checkpointer 会在 Graph 执行过程中保存 State Checkpoint。使用相同 thread_id 调用时，可以继续读取该 Thread 的状态。",
        url="https://docs.langchain.com/oss/javascript/langgraph/persistence",
    ),
    KnowledgeSource(
        id="LG-AGENTIC-RAG",
        evidenceType="agentic_rag",
        title="LangGraph Agentic RAG",
        content="Agentic RAG 让 Agent 根据当前任务决定是否检索，并在证据不足时继续查询、改写查询或结束回答。",
        url="https://docs.langchain.com/oss/javascript/langgraph/agentic-rag",
    ),
    KnowledgeSource(
        id="COURSE-TOOL-CALLING",
        evidenceType="tool_calling",
        title="课程资料：Tool Calling 执行边界",
        content="模型只负责生成 Tool Call；应用程序负责参数校验、真正执行工具，并把 Tool Result 回传给模型。",
        url="https://docs.langchain.com/oss/javascript/langchain/tools",
    ),
    KnowledgeSource(
        id="COURSE-CONTEXT-BUDGET",
        evidenceType="context_budget",
        title="课程资料：Context Budget",
        content="Context Budget 用于限制本次模型输入能够使用的 Token。应用应优先保留任务目标、关键事实和必要工具结果。",
        url="https://docs.langchain.com/oss/javascript/langchain/short-term-memory",
    ),
    KnowledgeSource(
        id="COURSE-EMBEDDING",
        evidenceType="embedding_retrieval",
        title="课程资料：Embedding 与向量检索",
        content="Embedding 模型把文本映射到同一向量空间；向量检索比较问题向量与文档向量，召回语义接近的候选内容。",
        url="https://docs.langchain.com/oss/javascript/integrations/text_embedding",
    ),
    KnowledgeSource(
        id="COURSE-AGENT-RUNTIME",
        evidenceType="agent_runtime",
        title="课程资料：Agent Runtime",
        content="Agent Runtime 负责管理运行状态、执行预算、工具结果校验和终止条件，不能只依赖模型自己决定何时结束。",
        url="https://docs.langchain.com/oss/javascript/langchain/agents",
    ),
]


class InterviewKnowledgeService:
    """提供面试反馈所需的课程依据。"""

    def search(self, evidence_type: str) -> list[dict]:
        """一次只返回指定类型的反馈依据。"""

        return [
            source.model_dump()
            for source in sources
            if source.evidenceType == evidence_type
        ]

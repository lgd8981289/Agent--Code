"""企业知识库问答主流程。"""

from __future__ import annotations

import time

from app.ai_service import AiService
from app.milvus_store import MilvusStore
from app.models import DemoUser, RetrievedChunk


class KnowledgeService:
    """执行检索、重排、答案生成和来源绑定。"""

    def __init__(self, ai: AiService, milvus: MilvusStore):
        self.ai = ai
        self.milvus = milvus

    def query(self, user: DemoUser, question: str) -> dict[str, object]:
        """执行一次完整的企业知识库问答。"""

        started_at = time.perf_counter()

        # 用户问题的向量用于 Dense 路线，原始文本同时用于 BM25 路线。
        # 用的全部都是 大模型的能力
        # 第一步：生成问题向量
        query_vector = self.ai.create_embeddings([question])[0]
        # 第二步：执行 Dense + BM25 混合检索
        retrieval = self.milvus.hybrid_search(user, question, query_vector)
        chunks = retrieval["chunks"]
        assert isinstance(chunks, list)
        # 第三步：对检索结果进行 Rerank 重排
        reranked = self.ai.rerank(question, chunks, 4)
        # 第四步：生成最终答案
        grounded_answer = self.ai.generate_answer(question, reranked)

        # 模型只返回 Chunk ID，最终来源信息必须从系统候选集重新绑定。
        chunk_by_id: dict[str, RetrievedChunk] = {
            chunk.chunk_id: chunk for chunk in reranked
        }
        sources = []
        for chunk_id in grounded_answer.source_chunk_ids:
            chunk = chunk_by_id.get(chunk_id)
            if not chunk:
                raise RuntimeError(f"没有找到模型引用的 Chunk：{chunk_id}")
            sources.append(
                {
                    "chunkId": chunk.chunk_id,
                    "documentId": chunk.document_id,
                    "title": chunk.title,
                    "version": chunk.version,
                    "chunkIndex": chunk.chunk_index,
                    "sourcePath": chunk.source_path,
                    "content": chunk.content,
                }
            )

        return {
            "status": grounded_answer.status,
            "answer": grounded_answer.answer,
            "sources": sources,
            "pipeline": {
                # 检索信息返回给演示前端，方便观察权限和精排是否生效。
                "permissionFilter": retrieval["filter"],
                "recalledCount": len(chunks),
                "rerankedCount": len(reranked),
                "latencyMs": round((time.perf_counter() - started_at) * 1000),
                "candidates": [
                    {
                        "rank": index + 1,
                        "chunkId": chunk.chunk_id,
                        "title": chunk.title,
                        "version": chunk.version,
                        "retrievalScore": chunk.retrieval_score,
                        "rerankScore": chunk.rerank_score,
                        "content": chunk.content,
                    }
                    for index, chunk in enumerate(reranked)
                ],
            },
        }


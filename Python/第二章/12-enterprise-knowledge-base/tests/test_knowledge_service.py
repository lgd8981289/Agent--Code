import unittest

from app.ai_service import REFUSAL_ANSWER
from app.knowledge_service import KnowledgeService
from app.models import DemoUser, GroundedAnswer, RetrievedChunk


USER = DemoUser(
    token="token",
    id="u-1",
    name="测试用户",
    tenant_id="bluewhale",
    tenant_name="蓝鲸科技",
    department_id="finance",
    department_name="财务部",
    role="employee",
)

CHUNK = RetrievedChunk(
    chunk_id="chunk-1",
    tenant_id="bluewhale",
    document_id="document-1",
    version=2,
    chunk_index=0,
    department_id="finance",
    visibility="department",
    title="报销规则",
    source_path="bluewhale/document-1/v2.md",
    checksum="hash",
    content="单笔报销超过 5000 元需要财务负责人审批。",
    retrieval_score=0.5,
    rerank_score=0.98,
)


class FakeAi:
    def create_embeddings(self, texts):
        return [[0.1, 0.2]]

    def rerank(self, question, chunks, top_n):
        return [CHUNK]

    def generate_answer(self, question, chunks):
        return GroundedAnswer(
            status="answered",
            answer="需要财务负责人审批。",
            source_chunk_ids=["chunk-1"],
        )


class FakeMilvus:
    def hybrid_search(self, user, question, query_vector):
        return {"filter": 'tenant_id == "bluewhale"', "chunks": [CHUNK]}


class KnowledgeServiceTest(unittest.TestCase):
    def test_bind_model_chunk_id_to_real_source(self):
        service = KnowledgeService(FakeAi(), FakeMilvus())

        result = service.query(USER, "6000 元报销需要谁审批？")

        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["answer"], "需要财务负责人审批。")
        self.assertEqual(
            result["sources"][0],
            {
                "chunkId": "chunk-1",
                "documentId": "document-1",
                "title": "报销规则",
                "version": 2,
                "chunkIndex": 0,
                "sourcePath": "bluewhale/document-1/v2.md",
                "content": "单笔报销超过 5000 元需要财务负责人审批。",
            },
        )

    def test_refusal_has_no_sources(self):
        class RefusalAi(FakeAi):
            def generate_answer(self, question, chunks):
                return GroundedAnswer(
                    status="insufficient_evidence",
                    answer=REFUSAL_ANSWER,
                    source_chunk_ids=[],
                )

        service = KnowledgeService(RefusalAi(), FakeMilvus())
        result = service.query(USER, "星河活动编号是多少？")
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertEqual(result["sources"], [])


if __name__ == "__main__":
    unittest.main()


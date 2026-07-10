import json
import unittest

from app.ai_service import AiService
from app.config import AppConfig
from app.exceptions import ServiceUnavailableError
from app.models import RetrievedChunk


def test_config() -> AppConfig:
    from pathlib import Path

    return AppConfig(
        zhipu_api_key="test-key",
        embedding_model="embedding-3",
        embedding_dimensions=512,
        rerank_model="rerank",
        chat_model="glm-4.7-flash",
        milvus_address="127.0.0.1:19530",
        milvus_collection="test",
        milvus_token=None,
        storage_root=Path("/tmp"),
        port=3000,
    )


def chunk(chunk_id: str = "chunk-1") -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        tenant_id="bluewhale",
        document_id="doc-1",
        version=1,
        chunk_index=0,
        department_id="finance",
        visibility="department",
        title="报销规则",
        source_path="bluewhale/doc-1/v1.md",
        checksum="hash",
        content="单笔报销超过 5000 元需要财务负责人审批。",
        retrieval_score=0.5,
    )


class AiServiceTest(unittest.TestCase):
    def test_embedding_restores_api_index_order(self):
        calls = []

        def requester(url, body, api_key):
            calls.append((url, body, api_key))
            return 200, {
                "data": [
                    {"index": 1, "embedding": [0.2]},
                    {"index": 0, "embedding": [0.1]},
                ]
            }

        service = AiService(test_config(), requester)
        self.assertEqual(service.create_embeddings(["a", "b"]), [[0.1], [0.2]])
        self.assertEqual(calls[0][1]["dimensions"], 512)

    def test_rerank_request_and_index_validation(self):
        bodies = []

        def requester(url, body, api_key):
            bodies.append(body)
            return 200, {"results": [{"index": 0, "relevance_score": 0.98}]}

        service = AiService(test_config(), requester)
        result = service.rerank("6000 元报销需要谁审批？", [chunk()], 4)

        self.assertEqual(result[0].rerank_score, 0.98)
        self.assertEqual(bodies[0]["top_n"], 1)
        self.assertFalse(bodies[0]["return_documents"])

    def test_generate_answer_validates_source_ids(self):
        def requester(url, body, api_key):
            self.assertEqual(body["response_format"], {"type": "json_object"})
            self.assertEqual(body["thinking"], {"type": "disabled"})
            return 200, {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "status": "answered",
                                    "answer": "需要财务负责人审批。",
                                    "sourceChunkIds": ["missing"],
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            }

        service = AiService(test_config(), requester)
        with self.assertRaisesRegex(ServiceUnavailableError, "不存在的 Chunk ID"):
            service.generate_answer("问题", [chunk()])


if __name__ == "__main__":
    unittest.main()


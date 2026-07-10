import tempfile
import unittest
from pathlib import Path

from app.config import AppConfig
from app.document_service import DocumentService
from app.models import DemoUser, SaveDocumentInput


class FakeAi:
    def __init__(self):
        self.calls = []

    def create_embeddings(self, texts):
        self.calls.append(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]


class FakeMilvus:
    def __init__(self, history=None):
        self.history = history or []
        self.inserted = []
        self.active_calls = []

    def query(self, _filter_expression):
        return list(self.history)

    def insert_chunks(self, rows):
        self.inserted.append(rows)

    def set_active(self, rows, is_active):
        self.active_calls.append((rows, is_active))


def test_config(storage_root: str) -> AppConfig:
    return AppConfig(
        zhipu_api_key="test-key",
        embedding_model="embedding-3",
        embedding_dimensions=512,
        rerank_model="rerank",
        chat_model="glm-4.7-flash",
        milvus_address="127.0.0.1:19530",
        milvus_collection="test",
        milvus_token=None,
        storage_root=Path(storage_root),
        port=3000,
    )


USER = DemoUser(
    token="admin-token",
    id="admin-1",
    name="管理员",
    tenant_id="bluewhale",
    tenant_name="蓝鲸科技",
    department_id="customer-service",
    department_name="客服部",
    role="admin",
)

INPUT = SaveDocumentInput(
    title="退款规则",
    department_id="customer-service",
    visibility="company",
    file_name="refund.md",
    content="# 退款规则\n\n退款金额超过 2000 元时，需要人工审核。".encode(),
)


def active_row(**overrides):
    row = {
        "chunk_id": "bluewhale:doc-1:v1:0:hash",
        "tenant_id": "bluewhale",
        "document_id": "doc-1",
        "version": 1,
        "chunk_index": 0,
        "is_active": True,
        "department_id": "customer-service",
        "visibility": "company",
        "title": "退款规则",
        "source_path": "bluewhale/doc-1/v1.md",
        "checksum": "old-hash",
        "content": "退款金额超过 2000 元时，需要人工审核。",
        "dense_vector": [0.1, 0.2, 0.3],
        "updated_at": 1,
    }
    row.update(overrides)
    return row


class DocumentServiceTest(unittest.TestCase):
    def create_service(self, history=None):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.ai = FakeAi()
        self.milvus = FakeMilvus(history)
        return DocumentService(test_config(self.temp_dir.name), self.ai, self.milvus)

    def test_create_document_chunks_embeds_inserts_and_activates(self):
        service = self.create_service()
        result = service.create_document(USER, INPUT)

        self.assertEqual(result["status"], "created")
        self.assertEqual(
            self.ai.calls[0],
            ["退款规则\n\n退款金额超过 2000 元时，需要人工审核。"],
        )
        row = self.milvus.inserted[0][0]
        self.assertEqual(row["tenant_id"], "bluewhale")
        self.assertEqual(row["version"], 1)
        self.assertFalse(row["is_active"])
        self.assertEqual(row["content"], "退款规则\n\n退款金额超过 2000 元时，需要人工审核。")
        self.assertEqual(self.milvus.active_calls[-1][1], True)

    def test_unchanged_document_skips_embedding(self):
        checksum = "f46a98672775e265a1676d1c24622c9b92624c7536c9d0ecea722020ab97fd07"
        service = self.create_service(
            [
                active_row(
                    checksum=checksum,
                    content="退款规则\n\n退款金额超过 2000 元时，需要人工审核。",
                )
            ]
        )

        result = service.update_document(USER, "doc-1", INPUT)

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(self.ai.calls, [])
        self.assertEqual(self.milvus.inserted, [])
        self.assertEqual(self.milvus.active_calls, [])

    def test_changed_document_creates_new_version_and_deactivates_old(self):
        old_row = active_row()
        service = self.create_service([old_row])
        result = service.update_document(
            USER,
            "doc-1",
            SaveDocumentInput(
                title=INPUT.title,
                department_id=INPUT.department_id,
                visibility=INPUT.visibility,
                file_name=INPUT.file_name,
                content="# 退款规则\n\n退款金额超过 3000 元时，需要人工审核。".encode(),
            ),
        )

        self.assertEqual(result["status"], "updated")
        self.assertEqual(self.milvus.inserted[0][0]["document_id"], "doc-1")
        self.assertEqual(self.milvus.inserted[0][0]["version"], 2)
        self.assertEqual(
            self.milvus.active_calls[0],
            ([{"chunkId": old_row["chunk_id"], "tenantId": "bluewhale"}], False),
        )
        self.assertTrue(self.milvus.active_calls[1][1])

    def test_delete_document_keeps_history_and_deactivates_current_chunks(self):
        old_row = active_row(is_active=False, version=1)
        current_row = active_row(
            chunk_id="bluewhale:doc-1:v2:0:hash",
            version=2,
            is_active=True,
        )
        service = self.create_service([old_row, current_row])

        result = service.delete_document(USER, "doc-1")

        self.assertEqual(result["status"], "deleted")
        self.assertEqual(
            self.milvus.active_calls[0],
            ([{"chunkId": current_row["chunk_id"], "tenantId": "bluewhale"}], False),
        )


if __name__ == "__main__":
    unittest.main()


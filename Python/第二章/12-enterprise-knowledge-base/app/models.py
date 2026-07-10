"""课程示例使用的数据结构。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


UserRole = Literal["admin", "employee"]
Visibility = Literal["company", "department"]


@dataclass(frozen=True)
class DemoUser:
    token: str
    id: str
    name: str
    tenant_id: str
    tenant_name: str
    department_id: str
    department_name: str
    role: UserRole

    def to_api(self) -> dict[str, str]:
        return {
            "token": self.token,
            "id": self.id,
            "name": self.name,
            "tenantId": self.tenant_id,
            "tenantName": self.tenant_name,
            "departmentId": self.department_id,
            "departmentName": self.department_name,
            "role": self.role,
        }


@dataclass(frozen=True)
class TextChunk:
    index: int
    content: str


@dataclass(frozen=True)
class SaveDocumentInput:
    title: str
    department_id: str
    visibility: Visibility
    file_name: str
    content: bytes


@dataclass(frozen=True)
class DocumentSummary:
    document_id: str
    title: str
    version: int
    department_id: str
    visibility: Visibility
    checksum: str
    source_path: str
    chunk_count: int
    updated_at: int

    def to_api(self) -> dict[str, object]:
        return {
            "documentId": self.document_id,
            "title": self.title,
            "version": self.version,
            "departmentId": self.department_id,
            "visibility": self.visibility,
            "checksum": self.checksum,
            "sourcePath": self.source_path,
            "chunkCount": self.chunk_count,
            "updatedAt": self.updated_at,
        }


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    tenant_id: str
    document_id: str
    version: int
    chunk_index: int
    department_id: str
    visibility: Visibility
    title: str
    source_path: str
    checksum: str
    content: str
    retrieval_score: float
    rerank_score: float | None = None

    def with_rerank_score(self, score: float) -> "RetrievedChunk":
        return RetrievedChunk(
            chunk_id=self.chunk_id,
            tenant_id=self.tenant_id,
            document_id=self.document_id,
            version=self.version,
            chunk_index=self.chunk_index,
            department_id=self.department_id,
            visibility=self.visibility,
            title=self.title,
            source_path=self.source_path,
            checksum=self.checksum,
            content=self.content,
            retrieval_score=self.retrieval_score,
            rerank_score=score,
        )


@dataclass(frozen=True)
class GroundedAnswer:
    status: Literal["answered", "insufficient_evidence"]
    answer: str
    source_chunk_ids: list[str]


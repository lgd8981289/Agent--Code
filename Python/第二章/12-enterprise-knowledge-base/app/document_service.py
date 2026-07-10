"""知识库文档入库、版本更新和软删除。"""

from __future__ import annotations

import hashlib
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from app.ai_service import AiService
from app.config import AppConfig, load_config
from app.exceptions import BadRequestError, NotFoundError
from app.filtering import build_document_filter, build_permission_filter
from app.markdown_chunker import chunk_markdown, normalize_markdown
from app.milvus_store import MilvusStore
from app.models import DemoUser, DocumentSummary, SaveDocumentInput, TextChunk


class DocumentService:
    """文档维护主流程。"""

    def __init__(
        self,
        config: AppConfig | None = None,
        ai: AiService | None = None,
        milvus: MilvusStore | None = None,
    ):
        self.config = config or load_config()
        self.ai = ai or AiService(self.config)
        self.milvus = milvus or MilvusStore(self.config)
        self.storage_root = self.config.storage_root
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def list_documents(self, user: DemoUser) -> list[DocumentSummary]:
        """查询当前用户有权访问的生效文档，并合并同一文档的 Chunk 信息。"""

        rows = self.milvus.query(build_permission_filter(user))
        return self.summarize(rows)

    def list_versions(
        self, user: DemoUser, document_id: str
    ) -> list[dict[str, object]]:
        """查询一份文档的全部历史版本。"""

        rows = self.milvus.query(
            build_document_filter(user.tenant_id, document_id)
        )
        if not rows:
            raise NotFoundError("没有找到这个文档。")

        # 一个版本可能包含多个 Chunk，需要先按版本号重新分组。
        versions: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            version = int(row["version"])
            versions.setdefault(version, []).append(row)

        results: list[dict[str, object]] = []
        for version, version_rows in versions.items():
            document = self.summarize(version_rows)[0].to_api()
            document["version"] = version
            document["isActive"] = bool(version_rows[0].get("is_active"))
            results.append(document)
        return sorted(results, key=lambda item: int(item["version"]), reverse=True)

    def create_document(self, user: DemoUser, input_data: SaveDocumentInput):
        """创建新文档，并为它分配不会与其他文档冲突的 ID。"""

        return self._save_version(user, str(uuid.uuid4()), input_data, False)

    def update_document(
        self, user: DemoUser, document_id: str, input_data: SaveDocumentInput
    ):
        """为已有文档发布新版本。"""

        return self._save_version(user, document_id, input_data, True)

    def delete_document(self, user: DemoUser, document_id: str):
        """删除已导入文档。

        这里采用软删除：保留历史版本和原始文件，只把生效 Chunk 全部置为不可检索。
        """

        def task():
            history = self.milvus.query(
                build_document_filter(user.tenant_id, document_id)
            )
            if not history:
                raise NotFoundError("没有找到这个文档。")

            active_rows = [row for row in history if bool(row.get("is_active"))]
            if not active_rows:
                return {
                    "status": "skipped",
                    "reason": "文档已经删除，不需要重复处理。",
                    "document": self.summarize(history)[0].to_api(),
                }

            self.milvus.set_active(
                [
                    {"chunkId": str(row["chunk_id"]), "tenantId": user.tenant_id}
                    for row in active_rows
                ],
                False,
            )

            return {
                "status": "deleted",
                "document": self.summarize(active_rows)[0].to_api(),
            }

        return self._with_lock(f"{user.tenant_id}:{document_id}", task)

    def _save_version(
        self,
        user: DemoUser,
        document_id: str,
        input_data: SaveDocumentInput,
        must_exist: bool,
    ):
        """RAG 文档入库主流程。"""

        def task():
            # 1. 读取上传的 Markdown，并统一换行、空白等格式，避免相同内容生成不同 checksum。
            try:
                markdown = normalize_markdown(input_data.content.decode("utf-8"))
            except UnicodeDecodeError as error:
                raise BadRequestError("Markdown 文档必须使用 UTF-8 编码。") from error
            if not markdown:
                raise BadRequestError("Markdown 文档不能为空。")

            # 2. 将 Markdown 按标题、段落等结构切分成多个 Chunk，后续检索的最小单位就是 Chunk。
            chunks = chunk_markdown(markdown)
            if not chunks:
                raise BadRequestError("文档中没有可以入库的正文。")

            # 3. 查询当前文档已有的 Chunk 记录，用于判断是否重复入库，以及计算新版本号。
            history = self.milvus.query(
                build_document_filter(user.tenant_id, document_id)
            )
            active_rows = [row for row in history if bool(row.get("is_active"))]

            if must_exist and not active_rows:
                raise NotFoundError("没有找到需要更新的文档。")

            # 4. 计算当前 Markdown 的 checksum，用来判断文档内容是否发生变化。
            checksum = self.hash_text(markdown)
            active = active_rows[0] if active_rows else None

            # 5. 如果内容、标题、部门、可见范围都没变，就不重复生成 Embedding，直接跳过。
            unchanged = (
                active is not None
                and str(active.get("checksum")) == checksum
                and str(active.get("title")) == input_data.title
                and str(active.get("department_id")) == input_data.department_id
                and str(active.get("visibility")) == input_data.visibility
            )

            if unchanged:
                return {
                    "status": "skipped",
                    "reason": "文档内容和权限元数据都没有变化，不需要重复生成向量。",
                    "document": self.summarize(active_rows)[0].to_api(),
                }

            # 6. 生成新的文档版本号，并记录当前版本原始 Markdown 的存储路径。
            version = max([0, *[int(row["version"]) for row in history]]) + 1
            source_path = f"{user.tenant_id}/{document_id}/v{version}.md"

            # 7. 为每个 Chunk 生成 Embedding 向量。
            # 注意：vectors 的顺序必须和 chunks 保持一致，方便后面按下标组装数据。
            vectors = self.ai.create_embeddings([chunk.content for chunk in chunks])

            # 8. 组装 Milvus 入库数据：
            # Chunk 正文 + Embedding 向量 + tenant_id / department_id / visibility / version 等元数据。
            rows = self.create_rows(
                user=user,
                document_id=document_id,
                version=version,
                checksum=checksum,
                source_path=source_path,
                input_data=input_data,
                chunks=chunks,
                vectors=vectors,
            )

            # 9. 保存原始 Markdown，方便后续审计、回溯和重新构建索引。
            self.write_source(source_path, markdown)

            # 10. 将新版本 Chunk 写入 Milvus。
            self.milvus.insert_chunks(rows)

            previous = [
                {"chunkId": str(row["chunk_id"]), "tenantId": user.tenant_id}
                for row in active_rows
            ]
            next_rows = [
                {"chunkId": row["chunk_id"], "tenantId": row["tenant_id"]}
                for row in rows
            ]

            # 11. 切换 RAG 检索使用的生效版本：
            # 旧 Chunk 失效，新 Chunk 生效。
            if previous:
                self.milvus.set_active(previous, False)
            try:
                self.milvus.set_active(next_rows, True)
            except Exception:
                # 如果新版本激活失败，恢复旧版本，避免线上知识库不可用。
                if previous:
                    self.milvus.set_active(previous, True)
                raise

            return {
                "status": "created" if not history else "updated",
                "document": self.summarize(rows)[0].to_api(),
            }

        return self._with_lock(f"{user.tenant_id}:{document_id}", task)

    def create_rows(
        self,
        *,
        user: DemoUser,
        document_id: str,
        version: int,
        checksum: str,
        source_path: str,
        input_data: SaveDocumentInput,
        chunks: list[TextChunk],
        vectors: list[list[float]],
    ) -> list[dict[str, Any]]:
        """把文档 Chunk、向量和 Metadata 组装成 Milvus 写入数据。"""

        updated_at = int(time.time() * 1000)
        rows: list[dict[str, Any]] = []
        for index, chunk in enumerate(chunks):
            rows.append(
                {
                    "chunk_id": (
                        f"{user.tenant_id}:{document_id}:v{version}:"
                        f"{chunk.index}:{self.hash_text(chunk.content)[:12]}"
                    ),
                    "tenant_id": user.tenant_id,
                    "document_id": document_id,
                    "version": version,
                    "chunk_index": chunk.index,
                    "is_active": False,
                    "department_id": input_data.department_id,
                    "visibility": input_data.visibility,
                    "title": input_data.title,
                    "source_path": source_path,
                    "checksum": checksum,
                    "content": chunk.content,
                    "dense_vector": vectors[index],
                    "updated_at": updated_at,
                }
            )
        return rows

    def summarize(self, rows: list[dict[str, Any]]) -> list[DocumentSummary]:
        """把 Chunk 行合并成文档摘要，供列表和版本接口展示。"""

        documents: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            key = f"{row['document_id']}:{int(row['version'])}"
            documents.setdefault(key, []).append(row)

        summaries: list[DocumentSummary] = []
        for document_rows in documents.values():
            first = document_rows[0]
            summaries.append(
                DocumentSummary(
                    document_id=str(first["document_id"]),
                    title=str(first["title"]),
                    version=int(first["version"]),
                    department_id=str(first["department_id"]),
                    visibility=first["visibility"],  # type: ignore[arg-type]
                    checksum=str(first["checksum"]),
                    source_path=str(first["source_path"]),
                    chunk_count=len(document_rows),
                    updated_at=int(first["updated_at"]),
                )
            )
        return sorted(summaries, key=lambda item: item.updated_at, reverse=True)

    def write_source(self, relative_path: str, markdown: str) -> None:
        """按租户、文档和版本目录保存原始 Markdown 文件。"""

        full_path = self.storage_root.joinpath(*relative_path.split("/"))
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(markdown, encoding="utf-8")

    @staticmethod
    def hash_text(text: str) -> str:
        """生成稳定的 SHA-256，用于内容去重和 Chunk ID 构造。"""

        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _with_lock(self, key: str, task):
        """对同一租户下的同一文档串行执行更新任务。

        这是单进程锁，多实例部署时应替换为任务队列或分布式锁。
        """

        with self._locks_guard:
            lock = self._locks.setdefault(key, threading.Lock())

        with lock:
            return task()


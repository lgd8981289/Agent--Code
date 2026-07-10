"""FastAPI 入口。"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    Request,
    UploadFile,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.ai_service import AiService
from app.auth import DEMO_USERS, assert_admin, get_user_from_authorization
from app.config import PROJECT_ROOT, load_config
from app.document_service import DocumentService
from app.exceptions import BadRequestError, KnowledgeBaseError
from app.knowledge_service import KnowledgeService
from app.milvus_store import MilvusStore
from app.models import DemoUser, SaveDocumentInput, Visibility


config = load_config()
ai_service = AiService(config)
milvus_store = MilvusStore(config)
document_service = DocumentService(config, ai_service, milvus_store)
knowledge_service = KnowledgeService(ai_service, milvus_store)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """启动时初始化 Milvus Collection，退出时关闭连接。"""

    milvus_store.ensure_collection()
    try:
        yield
    finally:
        milvus_store.close()


app = FastAPI(title="Enterprise Knowledge Base", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryKnowledgeBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)


@app.exception_handler(KnowledgeBaseError)
async def handle_business_error(
    _: Request, error: KnowledgeBaseError
) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"message": error.message},
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(
    _: Request, error: RequestValidationError
) -> JSONResponse:
    messages = [
        ".".join(str(item) for item in detail["loc"]) + " " + detail["msg"]
        for detail in error.errors()
    ]
    return JSONResponse(status_code=422, content={"message": messages})


def current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> DemoUser:
    """从当前请求中读取已经通过 Guard 校验的用户身份。"""

    return get_user_from_authorization(authorization)


def current_admin(user: Annotated[DemoUser, Depends(current_user)]) -> DemoUser:
    assert_admin(user)
    return user


def assert_markdown(file: UploadFile, content: bytes) -> None:
    """校验上传文件是否存在，并限制当前案例只处理 Markdown。"""

    filename = file.filename or ""
    if not filename:
        raise BadRequestError("请选择一个 Markdown 文档。")
    if not filename.lower().endswith(".md"):
        raise BadRequestError("当前案例只处理 .md 文档。")
    if len(content) > 2_000_000:
        raise BadRequestError("Markdown 文档不能超过 2 MB。")


@app.get("/api/health")
def health():
    """返回前端和运行检查使用的服务存活状态。"""

    from datetime import datetime, timezone

    return {
        "status": "ok",
        "service": "enterprise-knowledge-base",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/session/users")
def list_demo_users():
    """返回前端身份切换器需要的演示用户列表。"""

    return [user.to_api() for user in DEMO_USERS]


@app.get("/api/documents")
def list_documents(user: Annotated[DemoUser, Depends(current_user)]):
    """返回当前身份能够访问的生效文档。"""

    return [document.to_api() for document in document_service.list_documents(user)]


@app.get("/api/documents/{document_id}/versions")
def list_versions(
    document_id: str,
    user: Annotated[DemoUser, Depends(current_admin)],
):
    """返回指定文档的全部版本，供管理员审计和核对更新结果。"""

    return document_service.list_versions(user, document_id)


@app.post("/api/documents")
def create_document(
    user: Annotated[DemoUser, Depends(current_admin)],
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(min_length=1, max_length=120)],
    departmentId: Annotated[str, Form(min_length=1, max_length=64)],
    visibility: Annotated[Visibility, Form()],
):
    """接收 Markdown 文件并创建一份新的知识文档。"""

    content = file.file.read()
    assert_markdown(file, content)
    return document_service.create_document(
        user,
        SaveDocumentInput(
            title=title,
            department_id=departmentId,
            visibility=visibility,
            file_name=file.filename or "",
            content=content,
        ),
    )


@app.put("/api/documents/{document_id}")
def update_document(
    document_id: str,
    user: Annotated[DemoUser, Depends(current_admin)],
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(min_length=1, max_length=120)],
    departmentId: Annotated[str, Form(min_length=1, max_length=64)],
    visibility: Annotated[Visibility, Form()],
):
    """接收 Markdown 文件并为已有文档发布新版本。"""

    content = file.file.read()
    assert_markdown(file, content)
    return document_service.update_document(
        user,
        document_id,
        SaveDocumentInput(
            title=title,
            department_id=departmentId,
            visibility=visibility,
            file_name=file.filename or "",
            content=content,
        ),
    )


@app.delete("/api/documents/{document_id}")
def delete_document(
    document_id: str,
    user: Annotated[DemoUser, Depends(current_admin)],
):
    """软删除指定文档，让它从正常检索范围中移除。"""

    return document_service.delete_document(user, document_id)


@app.post("/api/knowledge/query")
def query_knowledge(
    user: Annotated[DemoUser, Depends(current_user)],
    body: QueryKnowledgeBody,
):
    """接收用户问题，并使用当前登录身份执行知识库问答。"""

    return knowledge_service.query(user, body.question.strip())


STATIC_ROOT = Path(PROJECT_ROOT, "app", "static")
app.mount("/", StaticFiles(directory=str(STATIC_ROOT), html=True), name="static")


"""导入项目预置的跨租户、跨部门样例文档。"""

from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.ai_service import AiService  # noqa: E402
from app.auth import DEMO_USER_BY_TOKEN  # noqa: E402
from app.config import load_config  # noqa: E402
from app.document_service import DocumentService  # noqa: E402
from app.milvus_store import MilvusStore  # noqa: E402
from app.models import SaveDocumentInput  # noqa: E402


SAMPLES = [
    {
        "token": "demo-bluewhale-admin",
        "file_name": "bluewhale-company-refund.md",
        "title": "蓝鲸科技退款规则",
        "department_id": "customer-service",
        "visibility": "company",
    },
    {
        "token": "demo-bluewhale-admin",
        "file_name": "bluewhale-customer-service.md",
        "title": "客服人工审核流程",
        "department_id": "customer-service",
        "visibility": "department",
    },
    {
        "token": "demo-bluewhale-admin",
        "file_name": "bluewhale-finance.md",
        "title": "财务对账与大额退款规则",
        "department_id": "finance",
        "visibility": "department",
    },
    {
        "token": "demo-starlight-admin",
        "file_name": "starlight-promotion.md",
        "title": "星河零售会员活动",
        "department_id": "marketing",
        "visibility": "company",
    },
]


def main() -> int:
    config = load_config()
    ai = AiService(config)
    milvus = MilvusStore(config)
    documents = DocumentService(config, ai, milvus)
    sample_root = PROJECT_ROOT / "sample_documents"

    try:
        milvus.ensure_collection()
        for sample in SAMPLES:
            user = DEMO_USER_BY_TOKEN.get(sample["token"])
            if not user:
                raise RuntimeError(f"没有找到演示用户：{sample['token']}")

            content = (sample_root / sample["file_name"]).read_bytes()
            # 使用对应租户管理员查询文档，避免跨租户判断同名数据。
            existing = next(
                (
                    document
                    for document in documents.list_documents(user)
                    if document.title == sample["title"]
                ),
                None,
            )
            input_data = SaveDocumentInput(
                title=sample["title"],
                department_id=sample["department_id"],
                visibility=sample["visibility"],  # type: ignore[arg-type]
                file_name=sample["file_name"],
                content=content,
            )
            result = (
                documents.update_document(user, existing.document_id, input_data)
                if existing
                else documents.create_document(user, input_data)
            )

            print(f"{sample['title']}：{result['status']}")
    finally:
        milvus.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


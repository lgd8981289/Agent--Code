"""运行配置。

Python 标准解释器不会自动读取 .env。本项目只读取当前进程已经存在的环境变量，
用户可以按 README 中的命令自行加载自己的 .env。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class AppConfig:
    zhipu_api_key: str | None
    embedding_model: str
    embedding_dimensions: int
    rerank_model: str
    chat_model: str
    milvus_address: str
    milvus_collection: str
    milvus_token: str | None
    storage_root: Path
    port: int


def load_config() -> AppConfig:
    """从进程环境变量中读取配置，并提供和 Node 版本一致的默认值。"""

    storage_root = os.getenv("STORAGE_ROOT")
    token = (os.getenv("MILVUS_TOKEN") or "").strip()
    api_key = (os.getenv("ZHIPU_API_KEY") or "").strip()

    return AppConfig(
        zhipu_api_key=api_key or None,
        embedding_model=os.getenv("EMBEDDING_MODEL", "embedding-3"),
        embedding_dimensions=int(os.getenv("EMBEDDING_DIMENSIONS", "512")),
        rerank_model=os.getenv("RERANK_MODEL", "rerank"),
        chat_model=os.getenv("CHAT_MODEL", "glm-4.7-flash"),
        milvus_address=os.getenv("MILVUS_ADDRESS", "127.0.0.1:19530"),
        milvus_collection=os.getenv(
            "MILVUS_COLLECTION", "enterprise_knowledge_chunks"
        ),
        milvus_token=token or None,
        storage_root=Path(storage_root).expanduser()
        if storage_root
        else PROJECT_ROOT / "storage" / "documents",
        port=int(os.getenv("PORT", "3000")),
    )


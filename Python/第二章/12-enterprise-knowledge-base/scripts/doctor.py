"""运行环境检查。"""

from __future__ import annotations

import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.config import load_config  # noqa: E402
from app.milvus_store import MilvusStore, normalize_milvus_uri  # noqa: E402


checks: list[dict[str, object]] = []


def record(name: str, passed: bool, detail: str) -> None:
    checks.append({"name": name, "passed": passed, "detail": detail})
    print(f"{'PASS' if passed else 'FAIL'}  {name}：{detail}")


def main() -> int:
    version = sys.version_info
    record(
        "Python",
        version >= (3, 11),
        f"当前版本 {version.major}.{version.minor}.{version.micro}，要求 3.11 以上",
    )

    record(
        "ZHIPU_API_KEY",
        bool(os.getenv("ZHIPU_API_KEY", "").strip()),
        "已配置" if os.getenv("ZHIPU_API_KEY") else "未配置",
    )

    dimensions = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))
    record("Embedding 维度", dimensions in {256, 512, 1024, 2048}, str(dimensions))

    config = load_config()
    try:
        store = MilvusStore(config)
        store.client.list_collections()
        record("Milvus 连接", True, normalize_milvus_uri(config.milvus_address))
    except Exception as error:
        record("Milvus 连接", False, str(error))
    finally:
        try:
            store.close()  # type: ignore[possibly-undefined]
        except Exception:
            pass

    if any(not check["passed"] for check in checks):
        return 1

    print("\n运行环境检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


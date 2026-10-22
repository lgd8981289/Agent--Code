"""跨模块使用的 JSON、时间与错误约定；业务金额一律为整数分。"""

import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4


def uid():
    return str(uuid4())


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def age_days(value):
    return (datetime.now(timezone.utc) - datetime.fromisoformat(value.replace("Z", "+00:00"))).total_seconds() / 86400


def dumps(value):
    # 和 JSON.stringify 一样保留中文及字段插入顺序，供政策摘要和输入 Hash 使用。
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode("utf-8")).hexdigest()


def js_length(value):
    return len(value.encode("utf-16-le")) // 2


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require(condition, message, status=400):
    if not condition:
        raise AppError(message, status)


async def cleanup_resources(actions):
    """逐项关闭，清理失败不掩盖原始业务错误。"""
    failures = []
    for action in actions:
        try:
            await action()
        except Exception as error:
            failures.append(error)
    return failures

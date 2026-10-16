"""JSON、Hash 与时间规范化，避免更换语言改变业务快照。"""

from datetime import datetime, timezone
import json
import math


def _normalize(value):
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON 不允许非有限数值")
        if value.is_integer() and abs(value) < 1e21:
            return int(value)
    return value


def dumps(value):
    # 金额故障中的 35.0 应输出为 35，与 JSON.stringify 的消息一致。
    return json.dumps(_normalize(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def loads(value):
    def reject_constant(token):
        raise ValueError(f"无效 JSON 数值：{token}")
    return json.loads(value, parse_constant=reject_constant)


def deep_equal(left, right):
    # Python 默认 True == 1；业务规则比较不能接受这种隐式转换。
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(deep_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(deep_equal(a, b) for a, b in zip(left, right))
    return left == right


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

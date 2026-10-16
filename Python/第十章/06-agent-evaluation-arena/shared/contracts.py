"""严格校验 API 输入，保留原课程的字段、边界及 JSON 字段顺序。"""

import re
from typing import Any

FAULTS = ("none", "wrong-unit", "drop-history", "unsafe-tools")
TOOLS = ("get_order", "read_policy", "save_preference", "submit_refund")


class SchemaError(ValueError):
    """参数合同错误由 HTTP 层统一转为 400，而非执行或评分异常。"""


def strict_object(value: Any, required: tuple[str, ...], optional=(), path="") -> dict:
    if not isinstance(value, dict):
        raise SchemaError(f"{path}: 必须是对象")
    if set(value) - set(required) - set(optional):
        raise SchemaError(f"{path}: 存在未声明字段")
    for key in required:
        if key not in value:
            raise SchemaError(f"{path}.{key}: 缺少必填字段")
    return value


def text(value: Any, path: str, minimum=0, maximum=None, trim=False) -> str:
    if not isinstance(value, str):
        raise SchemaError(f"{path}: 必须是字符串")
    value = value.strip() if trim else value
    # JavaScript 的字符串长度以 UTF-16 code unit 计数，中文表情也保持同一限制。
    length = len(value.encode("utf-16-le", errors="surrogatepass")) // 2
    if length < minimum or (maximum is not None and length > maximum):
        raise SchemaError(f"{path}: 字符串长度不符合要求")
    return value


def choice(value, options, path):
    if value not in options:
        raise SchemaError(f"{path}: 不支持的选项")
    return value


def integer(value, minimum, maximum, path):
    # bool 是 Python 的 int 子类，但 JSON true 不能当作 session 或并发数。
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not minimum <= value <= maximum or int(value) != value):
        raise SchemaError(f"{path}: 必须是 {minimum}～{maximum} 的整数")
    return int(value)


def array(value, path, minimum=0, maximum=None):
    if not isinstance(value, list) or len(value) < minimum or (maximum is not None and len(value) > maximum):
        raise SchemaError(f"{path}: 数组长度不符合要求")
    return value


def parse_version(value):
    value = strict_object(value, ("name", "model", "prompt", "fault"), ("parentId",))
    result = {key: text(value[key], key, 1, limit, trim=True)
              for key, limit in (("name", 80), ("model", 120), ("prompt", 8000))}
    result["fault"] = choice(value["fault"], FAULTS, "fault")
    if "parentId" in value:
        result["parentId"] = text(value["parentId"], "parentId")
    return result


def parse_sample(value):
    value = strict_object(value, ("id", "name", "category", "turns", "fixture", "expected"))
    sample_id = text(value["id"], "id")
    if not re.fullmatch(r"[a-z0-9-]{1,60}", sample_id):
        raise SchemaError("id: 只能使用小写字母、数字和连字符，长度 1～60")
    turns = []
    for turn in array(value["turns"], "turns", 1, 5):
        turn = strict_object(turn, ("question", "session"), path="turns")
        turns.append({"question": text(turn["question"], "question", 1, 6000),
                      "session": integer(turn["session"], 1, 5, "session")})
    fixture = strict_object(value["fixture"], ("injectedDocument", "approved"), path="fixture")
    for key in fixture:
        if not isinstance(fixture[key], bool):
            raise SchemaError(f"fixture.{key}: 必须是布尔值")
    expected = strict_object(value["expected"], ("requiredTools", "orderId", "refunds", "preference", "answerRequirement"), path="expected")
    return {
        "id": sample_id,
        "name": text(value["name"], "name", 1, 120),
        "category": choice(value["category"], ("normal", "security", "control"), "category"),
        "turns": turns,
        "fixture": {key: fixture[key] for key in ("injectedDocument", "approved")},
        "expected": {
            "requiredTools": [choice(tool, TOOLS, "requiredTools") for tool in array(expected["requiredTools"], "requiredTools")],
            "orderId": None if expected["orderId"] is None else text(expected["orderId"], "orderId"),
            "refunds": integer(expected["refunds"], 0, 1, "refunds"),
            "preference": choice(expected["preference"], ("brief", "detailed", None), "preference"),
            "answerRequirement": text(expected["answerRequirement"], "answerRequirement", 1, 4000),
        },
    }


def parse_dataset(value):
    value = strict_object(value, ("name", "cases"))
    cases = [parse_sample(case) for case in array(value["cases"], "cases", 1, 30)]
    if len({case["id"] for case in cases}) != len(cases):
        raise SchemaError("样本 ID 不能重复")
    for case in cases:
        sessions = [turn["session"] for turn in case["turns"]]
        if sessions[0] != 1 or any(current not in (previous, previous + 1) for previous, current in zip(sessions, sessions[1:])):
            raise SchemaError(f"{case['id']} 的 session 必须从 1 开始，保持或递增 1")
    return {"name": text(value["name"], "name", 1, 80), "cases": cases}


def parse_run(value):
    value = strict_object(value, ("datasetId", "baselineId", "candidateId", "mode", "caseIds"), ("concurrency",))
    result = {key: text(value[key], key) for key in ("datasetId", "baselineId", "candidateId")}
    result.update(mode=choice(value["mode"], ("replay", "ai"), "mode"),
                  caseIds=[text(item, "caseIds") for item in array(value["caseIds"], "caseIds", 1, 30)],
                  concurrency=integer(value.get("concurrency", 1), 1, 2, "concurrency"))
    if result["baselineId"] == result["candidateId"]:
        raise SchemaError("请选择两个不同版本")
    return result


def parse_review(value):
    value = strict_object(value, ("verdict", "note"))
    return {"verdict": choice(value["verdict"], ("agree", "disagree"), "verdict"),
            "note": text(value["note"], "note", 1, 2000, trim=True)}


def parse_judge(value):
    value = strict_object(value, ("passed", "reason", "quotes"))
    if not isinstance(value["passed"], bool):
        raise SchemaError("passed: 必须是布尔值")
    return {"passed": value["passed"], "reason": text(value["reason"], "reason", 1),
            "quotes": [text(item, "quotes", 1) for item in array(value["quotes"], "quotes", 1)]}

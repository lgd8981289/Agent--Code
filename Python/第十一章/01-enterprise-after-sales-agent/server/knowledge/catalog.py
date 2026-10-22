"""进程固定一个政策目录版本；重启后切换，发布时同步更新索引。"""

import json
import re
from ..common import require, dumps, sha
from ..config import ROOT

POLICY_FIELDS = ("id", "tenantId", "title", "version", "active", "category", "content", "source")


def load_catalog(root=ROOT):
    policies = json.loads((root / "knowledge/policies.json").read_text())
    require(isinstance(policies, list), "政策目录必须是数组")
    seen = set()
    for p in policies:
        require(all(k in p for k in POLICY_FIELDS) and re.fullmatch(r"POL-[A-Z0-9-]+", p["id"]) and p["tenantId"] and p["title"] and p["source"] and
                type(p["version"]) is int and p["version"] > 0 and type(p["active"]) is bool and
                p["category"] in ("eligibility", "materials", "approval") and 0 < len(p["content"]) <= 8000, "政策目录格式无效")
        key = (p["tenantId"], p["id"])
        require(key not in seen, "政策目录存在重复的租户/资料 ID")
        seen.add(key)
    return policies


def policy_hash(policy):
    return sha(dumps({k: policy[k] for k in POLICY_FIELDS}))

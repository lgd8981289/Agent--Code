"""小型政策库真实 BM25 排序；租户、有效性与分类先过滤。"""

import math
from .config import Config
from .knowledge.catalog import load_catalog, policy_hash
from .knowledge.segmenter import tokens


def retrieve(query, tenant, category=None, catalog=None):
    docs = [p for p in (load_catalog() if catalog is None else catalog) if p["tenantId"] == tenant and p["active"] and (not category or p["category"] == category)]
    terms = list(dict.fromkeys(tokens(query)))
    all_tokens = [tokens(d["title"] + d["content"]) for d in docs]
    average = sum(map(len, all_tokens)) / (len(all_tokens) or 1)
    scored = []
    for doc, words in zip(docs, all_tokens):
        score = 0
        for term in terms:
            frequency, df = words.count(term), sum(term in a for a in all_tokens)
            idf = math.log(1 + (len(docs) - df + .5) / (df + .5))
            score += idf * frequency * 2.2 / (frequency + 1.2 * (.25 + .75 * len(words) / (average or 1)))
        if score > 0:
            scored.append({**doc, "score": score})
    return sorted(scored, key=lambda d: -d["score"])[:3]


class Knowledge:
    def __init__(self, config=None, hybrid=None):
        self.config = config or Config()
        self.policies = load_catalog(self.config.root)
        self.hybrid = hybrid

    def revalidate(self, tenant, snapshots):
        result = []
        for snapshot in snapshots:
            current = next((p for p in self.policies if p["id"] == snapshot.get("id") and p["tenantId"] == tenant and p["active"]), None)
            if current and policy_hash(current) == policy_hash(snapshot):
                result.append(current)
        return result

    async def search(self, query, tenant, category=None, mode="replay"):
        backend = self.config.value("KNOWLEDGE_BACKEND", "local")
        if mode == "replay" or backend == "local":
            return retrieve(query, tenant, category, self.policies)
        if backend != "milvus":
            raise ValueError("KNOWLEDGE_BACKEND 仅支持 local 或 milvus")
        if self.hybrid is None:
            from .knowledge.milvus import MilvusPolicies
            self.hybrid = MilvusPolicies.connect(self.config)
        return await self.hybrid.search(query, tenant, category, self.policies)

    async def close(self):
        if self.hybrid:
            await self.hybrid.close()

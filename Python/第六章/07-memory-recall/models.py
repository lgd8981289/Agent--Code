"""
本节用到的 Embedding 和回答模型。

本文件对应 Node 版的 models.js。
"""

from __future__ import annotations

import json
import math
import os
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from langchain_core.embeddings import Embeddings


class ZhipuEmbeddings(Embeddings):
    """沿用第二章的智谱接口，适配 Store 所需的两个 Embeddings 方法。"""

    def __init__(self) -> None:
        super().__init__()
        try:
            self.dimensions = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))
        except ValueError as exc:
            raise RuntimeError(
                "本例使用 embedding-3，维度可选 256、512、1024、2048。"
            ) from exc

        self.model = os.getenv("EMBEDDING_MODEL", "embedding-3")

        if not os.getenv("ZHIPU_API_KEY"):
            raise RuntimeError("缺少 ZHIPU_API_KEY。")

        if self.model != "embedding-3" or self.dimensions not in [
            256,
            512,
            1024,
            2048,
        ]:
            raise RuntimeError("本例使用 embedding-3，维度可选 256、512、1024、2048。")

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """批量将记忆正文变成向量；小案例单次不超过 64 条。"""

        if len(texts) == 0:
            return []

        if len(texts) > 64:
            raise RuntimeError("单次最多支持 64 条文本，请分批处理。")

        payload = {
            "model": self.model,
            "dimensions": self.dimensions,
            "input": texts,
        }
        request = Request(
            "https://open.bigmodel.cn/api/paas/v4/embeddings",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {os.environ['ZHIPU_API_KEY']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise RuntimeError(f"智谱 Embedding 请求失败，HTTP {error.code}。") from error

        rows = sorted(result.get("data") or [], key=lambda row: row.get("index", -1))

        if len(rows) != len(texts):
            raise RuntimeError("Embedding 返回的数量、下标或向量维度不正确。")

        embeddings: list[list[float]] = []
        for index, row in enumerate(rows):
            embedding = row.get("embedding")
            if (
                row.get("index") != index
                or not isinstance(embedding, list)
                or len(embedding) != self.dimensions
                or any(not isinstance(value, (int, float)) for value in embedding)
                or any(not math.isfinite(float(value)) for value in embedding)
                or not any(float(value) != 0 for value in embedding)
            ):
                raise RuntimeError("Embedding 返回的数量、下标或向量维度不正确。")

            embeddings.append([float(value) for value in embedding])

        return embeddings

    def embed_query(self, text: str) -> list[float]:
        """用户问题必须和记忆正文使用同一模型、同一维度。"""

        return self.embed_documents([text])[0]


def create_answer_model() -> Any:
    """召回完成后，使用整理好的上下文生成回答。"""

    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY。")

    try:
        from langchain_deepseek import ChatDeepSeek
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langchain-deepseek 依赖，请先执行：python -m pip install -e ."
        ) from exc

    return ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
        max_retries=2,
        timeout=60,
        model_kwargs={
            "thinking": {"type": "disabled"},
        },
    )

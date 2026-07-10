"""模型调用服务。"""

from __future__ import annotations

import json
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import AppConfig, load_config
from app.exceptions import ServiceUnavailableError
from app.models import GroundedAnswer, RetrievedChunk


REFUSAL_ANSWER = "根据当前知识库资料，无法回答这个问题。"
SUPPORTED_DIMENSIONS = {256, 512, 1024, 2048}

JsonRequester = Callable[[str, dict[str, Any], str], tuple[int, dict[str, Any]]]


def request_json_with_retry(
    url: str,
    body: dict[str, Any],
    api_key: str,
    *,
    max_attempts: int = 3,
) -> tuple[int, dict[str, Any]]:
    """发送模型请求，并对限流和服务端错误进行有限次数重试。"""

    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last_status = 0
    last_result: dict[str, Any] = {}

    for attempt in range(1, max_attempts + 1):
        request = Request(
            url,
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=60) as response:
                text = response.read().decode("utf-8")
                return response.status, json.loads(text) if text else {}
        except HTTPError as error:
            last_status = error.code
            text = error.read().decode("utf-8", errors="replace")
            try:
                last_result = json.loads(text)
            except json.JSONDecodeError:
                last_result = {"message": text}
        except URLError as error:
            raise ServiceUnavailableError(f"模型服务请求失败：{error}") from error

        retryable = last_status == 429 or last_status >= 500
        if not retryable or attempt == max_attempts:
            return last_status, last_result

        # 使用指数退避，避免模型服务繁忙时立即连续重试。
        time.sleep(0.4 * 2 ** (attempt - 1))

    raise ServiceUnavailableError("模型服务没有返回响应。")


class AiService:
    """Embedding、Rerank 和答案生成的统一封装。"""

    def __init__(
        self,
        config: AppConfig | None = None,
        requester: JsonRequester = request_json_with_retry,
    ):
        self.config = config or load_config()
        self.requester = requester

    def _assert_config(self) -> str:
        """校验模型调用所需配置，并返回可用的 API Key。"""

        if not self.config.zhipu_api_key:
            raise ServiceUnavailableError(
                "没有检测到 ZHIPU_API_KEY，无法调用 Embedding、Rerank 和答案生成模型。"
            )

        if self.config.embedding_dimensions not in SUPPORTED_DIMENSIONS:
            raise ServiceUnavailableError(
                "EMBEDDING_DIMENSIONS 只能是 256、512、1024 或 2048。"
            )

        return self.config.zhipu_api_key

    def create_embeddings(self, inputs: list[str]) -> list[list[float]]:
        """把文本批量转换成稠密向量。

        Args:
            inputs: 等待向量化的 Chunk 或用户问题。

        Returns:
            与 inputs 顺序一致的向量数组。
        """

        api_key = self._assert_config()
        output: list[list[float]] = []

        # Embedding API 单次最多处理 64 条数据，文档较大时需要分批调用。
        for start in range(0, len(inputs), 64):
            batch = inputs[start : start + 64]
            status, result = self.requester(
                "https://open.bigmodel.cn/api/paas/v4/embeddings",
                {
                    "model": self.config.embedding_model,
                    "input": batch,
                    "dimensions": self.config.embedding_dimensions,
                },
                api_key,
            )

            data = result.get("data")
            if status < 200 or status >= 300 or not isinstance(data, list):
                raise ServiceUnavailableError(
                    f"Embedding API 调用失败：{status} {json.dumps(result, ensure_ascii=False)}"
                )

            try:
                # 根据接口返回的 index 恢复输入顺序，保证 Chunk 和向量一一对应。
                sorted_items = sorted(data, key=lambda item: item["index"])
                output.extend(item["embedding"] for item in sorted_items)
            except (KeyError, TypeError) as error:
                raise ServiceUnavailableError(
                    "Embedding API 没有返回可用的向量。"
                ) from error

        return output

    def rerank(
        self, question: str, chunks: list[RetrievedChunk], top_n: int = 4
    ) -> list[RetrievedChunk]:
        """使用专用 Rerank 模型对候选 Chunk 重新排序。"""

        if not chunks:
            return []

        api_key = self._assert_config()
        status, result = self.requester(
            "https://open.bigmodel.cn/api/paas/v4/rerank",
            {
                "model": self.config.rerank_model,
                "query": question,
                "documents": [
                    f"{chunk.title}\n{chunk.content}" for chunk in chunks
                ],
                "top_n": min(top_n, len(chunks)),
                "return_documents": False,
                "return_raw_scores": True,
            },
            api_key,
        )

        results = result.get("results")
        if status < 200 or status >= 300 or not isinstance(results, list):
            raise ServiceUnavailableError(
                f"Rerank API 调用失败：{status} {json.dumps(result, ensure_ascii=False)}"
            )

        reranked: list[RetrievedChunk] = []
        for item in results:
            index = int(item["index"])
            if index < 0 or index >= len(chunks):
                raise ServiceUnavailableError(
                    f"Rerank API 返回了无效文档下标：{index}"
                )
            reranked.append(
                chunks[index].with_rerank_score(float(item["relevance_score"]))
            )
        return reranked

    def generate_answer(
        self, question: str, chunks: list[RetrievedChunk]
    ) -> GroundedAnswer:
        """根据精排后的 Chunk 生成有依据的回答。"""

        if not chunks:
            return self._create_refusal()

        api_key = self._assert_config()
        status, result = self.requester(
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            {
                "model": self.config.chat_model,
                "messages": self._build_answer_messages(question, chunks),
                "response_format": {"type": "json_object"},
                "thinking": {"type": "disabled"},
                "temperature": 0,
                "stream": False,
            },
            api_key,
        )

        if status < 200 or status >= 300:
            raise ServiceUnavailableError(
                f"答案生成失败：{status} {json.dumps(result, ensure_ascii=False)}"
            )

        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise ServiceUnavailableError("答案生成模型没有返回内容。") from error

        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as error:
            raise ServiceUnavailableError(f"模型没有返回合法 JSON：{content}") from error

        # JSON 模式只能约束输出格式，模型返回的状态和引用仍需程序校验。
        return self._validate_answer(parsed, chunks)

    def _build_answer_messages(
        self, question: str, chunks: list[RetrievedChunk]
    ) -> list[dict[str, str]]:
        """构造答案生成所需的 system 和 user message。"""

        return [
            {
                "role": "system",
                "content": f"""你是企业知识库问答助手，只能根据本次提供的知识库 Chunk 回答。

规则：
1. Chunk 能直接支持答案时，返回 status=answered，并给出 answer 和直接支持答案的 sourceChunkIds。
2. Chunk 无法支持答案时，不得使用模型自身知识补充或猜测。返回 status=insufficient_evidence、answer="{REFUSAL_ANSWER}"、sourceChunkIds=[]。
3. sourceChunkIds 只能从本次提供的 Chunk ID 中选择。
4. 资料给出了明确的金额、时间或条件阈值时，可以用用户提供的数据做简单比较，这仍然属于有依据的回答。
5. 回答“会不会、是否”这类问题时，第一句直接写“会”或“不会”，不要用含糊的“是的”或“不是”。
6. 只返回 JSON：{{"status":"answered 或 insufficient_evidence","answer":"答案","sourceChunkIds":["Chunk ID"]}}""",
            },
            {
                "role": "user",
                "content": "用户问题："
                + question
                + "\n\n知识库 Chunk：\n"
                + json.dumps(
                    [
                        {
                            "id": chunk.chunk_id,
                            "title": chunk.title,
                            "content": chunk.content,
                        }
                        for chunk in chunks
                    ],
                    ensure_ascii=False,
                    indent=2,
                ),
            },
        ]

    def _validate_answer(
        self, value: Any, chunks: list[RetrievedChunk]
    ) -> GroundedAnswer:
        """校验模型返回的回答结构和来源 ID。"""

        if not isinstance(value, dict):
            raise ServiceUnavailableError("模型没有返回 JSON 对象。")

        if value.get("status") == "insufficient_evidence":
            return self._create_refusal()

        answer = value.get("answer")
        source_chunk_ids = value.get("sourceChunkIds")
        if (
            value.get("status") != "answered"
            or not isinstance(answer, str)
            or not answer.strip()
            or not isinstance(source_chunk_ids, list)
            or not source_chunk_ids
        ):
            raise ServiceUnavailableError("模型返回的回答结构不完整。")

        allowed_ids = {chunk.chunk_id for chunk in chunks}
        deduped_source_ids: list[str] = []
        for chunk_id in source_chunk_ids:
            if chunk_id not in deduped_source_ids:
                deduped_source_ids.append(chunk_id)

        if any(chunk_id not in allowed_ids for chunk_id in deduped_source_ids):
            raise ServiceUnavailableError("模型引用了不存在的 Chunk ID。")

        return GroundedAnswer(
            status="answered",
            answer=answer.strip(),
            source_chunk_ids=deduped_source_ids,
        )

    def _create_refusal(self) -> GroundedAnswer:
        """创建系统统一的拒答结果。"""

        return GroundedAnswer(
            status="insufficient_evidence",
            answer=REFUSAL_ANSWER,
            source_chunk_ids=[],
        )


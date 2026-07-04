"""计算 RAG 检索指标，并使用评估模型判断答案忠实度。"""

import json
import os
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


DEFAULT_EVALUATOR_MODEL = "glm-4.7-flash"

FaithfulnessRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def recall_at_k(
    retrieved_chunks: list[dict[str, Any]],
    relevant_chunk_ids: list[str],
    k: int,
) -> float | None:
    """计算单个问题的 Recall@K。"""
    # Recall@K = TopK 中命中的相关 Chunk 数量 / 全部相关 Chunk 数量
    #
    # k 必须是正整数，比如 3、5、10。
    # 如果 k 不合法，后面的 TopK 计算就没有意义。
    if not isinstance(k, int) or isinstance(k, bool) or k <= 0:
        raise ValueError("k 必须是大于 0 的整数。")

    # relevant_chunk_ids 表示“这个问题真正应该命中的相关资料”。
    # 如果没有标注相关资料，就无法计算 Recall@K。
    # 这里返回 None，表示该样本不参与 Recall@K 统计。
    if not isinstance(relevant_chunk_ids, list) or not relevant_chunk_ids:
        return None

    # 取出系统检索结果中的前 K 条，并只保留每个 Chunk 的 id。
    # 使用 set 是为了方便判断相关 Chunk id 是否出现在 TopK 中。
    top_k_ids = {chunk["id"] for chunk in retrieved_chunks[:k]}

    # 对人工标注的相关 Chunk ID 去重，避免分母被重复计算。
    unique_relevant_ids = list(dict.fromkeys(relevant_chunk_ids))

    # 统计 TopK 结果中命中了多少个相关 Chunk。
    #
    # 举例：
    # TopK = ['chunk-a', 'chunk-b', 'chunk-x']
    # Relevant = ['chunk-a', 'chunk-c']
    # 那么只命中了 chunk-a，hit_count = 1。
    hit_count = sum(
        chunk_id in top_k_ids for chunk_id in unique_relevant_ids
    )

    # 按公式计算 Recall@K：
    # 命中的相关 Chunk 数量 / 全部相关 Chunk 数量
    return hit_count / len(unique_relevant_ids)


def reciprocal_rank(
    retrieved_chunks: list[dict[str, Any]],
    relevant_chunk_ids: list[str],
    k: int,
) -> float | None:
    """计算单个问题的 Reciprocal Rank，也就是 RR。"""
    # RR 用来评估：第一份相关 Chunk 在检索结果中排得有多靠前。
    #
    # 计算方式：RR = 1 / 第一份相关 Chunk 的排名
    #
    # 举例：
    # - 第一份相关 Chunk 排在第 1 位：RR = 1 / 1 = 1
    # - 第一份相关 Chunk 排在第 2 位：RR = 1 / 2 = 0.5
    # - 第一份相关 Chunk 排在第 3 位：RR = 1 / 3 ≈ 0.333
    # - TopK 内没有任何相关 Chunk：RR = 0

    # k 必须是正整数，比如 3、5、10。
    # 如果 k 不合法，就无法明确“只看前 K 条”的范围。
    if not isinstance(k, int) or isinstance(k, bool) or k <= 0:
        raise ValueError("k 必须是大于 0 的整数。")

    # 如果这个问题没有人工标注的相关 Chunk，就无法计算 RR。
    # 这里返回 None，表示该样本不参与后续 MRR 统计。
    if not isinstance(relevant_chunk_ids, list) or not relevant_chunk_ids:
        return None

    # 把人工标注的相关 Chunk ID 转成 set，方便后面判断某个
    # chunk.id 是否属于相关 Chunk。
    relevant_id_set = set(relevant_chunk_ids)

    # 只取检索结果的前 K 条，从前往后查找第一份相关资料。
    # enumerate(..., start=1) 直接得到从 1 开始的真实排名。
    for rank, chunk in enumerate(retrieved_chunks[:k], start=1):
        if chunk["id"] in relevant_id_set:
            return 1 / rank

    # 如果 TopK 里面没有任何相关 Chunk，则 RR = 0。
    return 0


def mean(values: list[float]) -> float:
    """计算一组数字的平均值。"""
    # 平均值的计算方式：mean = 所有数字之和 / 数字个数
    #
    # 举例：
    # values = [1, 2, 3]
    # mean = (1 + 2 + 3) / 3 = 2
    if not isinstance(values, list) or not values:
        raise ValueError("计算平均值时至少需要一个数字。")

    return sum(values) / len(values)


def build_faithfulness_messages(
    evaluation_case: dict[str, Any],
) -> list[dict[str, str]]:
    """构造 Faithfulness 评估所需的 messages。"""
    # 评估模型负责两件事：
    # 1. 把答案拆成能够独立判断的 Claim
    # 2. 判断每个 Claim 是否能被检索上下文直接支持
    #
    # 最终分数不交给模型计算，避免模型随意给出一个总分。
    contexts = [
        {
            "id": chunk["id"],
            "title": chunk["title"],
            "content": chunk["content"],
        }
        for chunk in evaluation_case["retrievedChunks"]
    ]

    return [
        {
            "role": "system",
            "content": """你是 RAG 系统的 Faithfulness 评估器。

请把“待评估答案”拆成能够独立判断真假的 Claim，再判断每个 Claim 是否能从“检索上下文”中直接推出。

严格遵守以下规则：
1. 只能使用检索上下文，不得使用外部知识。
2. supported 只有在上下文能够直接支持 Claim 时才为 true。
3. supportingChunkIds 只能填写直接支持该 Claim 的 Chunk ID。
4. supported 为 false 时，supportingChunkIds 必须是空数组。
5. 不要评价答案是否流畅，也不要回答用户问题。
6. 只返回 JSON：
{"claims":[{"claim":"答案中的一个独立主张","supported":true,"supportingChunkIds":["Chunk ID"]}]}""",
        },
        {
            "role": "user",
            "content": (
                f"用户问题：{evaluation_case['question']}\n\n"
                "检索上下文：\n"
                f"{json.dumps(contexts, ensure_ascii=False, indent=2)}\n\n"
                "待评估答案：\n"
                f"{evaluation_case['answer']}"
            ),
        },
    ]


def request_faithfulness_judgement(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """使用智谱 Chat Completions 接口执行 Faithfulness 判断。"""
    request = Request(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        error_text = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Faithfulness 评估失败：{error.code} {error_text}"
        ) from error


def validate_claim_judgements(
    result: Any, retrieved_chunks: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """校验评估模型返回的 Claim 列表。"""
    if not isinstance(result, dict) or not isinstance(
        result.get("claims"), list
    ):
        raise ValueError("评估模型没有返回有效的 claims。")

    if not result["claims"]:
        raise ValueError("当前答案没有可评估的 Claim。")

    available_chunk_ids = {chunk["id"] for chunk in retrieved_chunks}
    validated_claims: list[dict[str, Any]] = []

    for index, item in enumerate(result["claims"], start=1):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index} 个 Claim 不是对象。")

        claim = item.get("claim")
        if not isinstance(claim, str) or not claim.strip():
            raise ValueError(f"第 {index} 个 Claim 缺少有效文本。")

        supported = item.get("supported")
        if not isinstance(supported, bool):
            raise ValueError(f"第 {index} 个 Claim 缺少 supported。")

        raw_supporting_chunk_ids = item.get("supportingChunkIds")
        if not isinstance(raw_supporting_chunk_ids, list):
            raise ValueError(
                f"第 {index} 个 Claim 的 supportingChunkIds 必须是数组。"
            )

        # 先逐项校验，再按模型返回顺序去重。
        # 不能直接用 set 去重，因为模型可能返回字典、列表等不可哈希值。
        supporting_chunk_ids: list[str] = []
        for chunk_id in raw_supporting_chunk_ids:
            if (
                not isinstance(chunk_id, str)
                or chunk_id not in available_chunk_ids
            ):
                raise ValueError(
                    f"评估模型引用了不存在的 Chunk ID：{chunk_id}"
                )
            if chunk_id not in supporting_chunk_ids:
                supporting_chunk_ids.append(chunk_id)

        if supported and not supporting_chunk_ids:
            raise ValueError(
                f"第 {index} 个 Claim 缺少支持它的 Chunk ID。"
            )

        if not supported and supporting_chunk_ids:
            raise ValueError("不受支持的 Claim 不应该绑定 Chunk ID。")

        validated_claims.append(
            {
                "claim": claim.strip(),
                "supported": supported,
                "supportingChunkIds": supporting_chunk_ids,
            }
        )

    return validated_claims


def evaluate_faithfulness(
    evaluation_case: dict[str, Any],
    *,
    api_key: str | None = None,
    evaluator_model: str | None = None,
    requester: FaithfulnessRequester = request_faithfulness_judgement,
) -> dict[str, Any]:
    """计算单个答案的 Faithfulness，也就是“忠实度”。"""
    # Faithfulness 用来评估：
    # 大模型生成的答案，是否忠实于检索回来的上下文资料。
    #
    # 在这里，我们把答案拆成多个 Claim，也就是多个“答案断言”。
    #
    # 计算方式：Faithfulness = 有上下文支持的 Claim 数量 / 全部 Claim 数量
    #
    # 举例：全部 Claim 数量 = 4，有上下文支持的 Claim 数量 = 3，
    # Faithfulness = 3 / 4 = 0.75。

    # Faithfulness 评估需要调用大模型。
    # 如果没有配置 API Key，就无法发起评估请求。
    resolved_api_key = (
        api_key if api_key is not None else os.getenv("ZHIPU_API_KEY")
    )
    if not resolved_api_key:
        raise RuntimeError(
            "没有检测到 ZHIPU_API_KEY，无法执行 Faithfulness 评估。"
        )

    resolved_model = (
        evaluator_model
        if evaluator_model is not None
        else os.getenv("EVALUATOR_MODEL")
        or os.getenv("CHAT_MODEL")
        or DEFAULT_EVALUATOR_MODEL
    )

    # 调用评估模型，让模型判断答案中的每个 Claim 是否能被检索上下文支持。
    # 这里不是让模型重新回答问题，而是让模型扮演“评测器”的角色。
    response = requester(
        {
            # 指定评估模型。
            "model": resolved_model,

            # messages 中包含用户问题、答案、检索 Chunk 和评估要求。
            "messages": build_faithfulness_messages(evaluation_case),

            # 要求模型返回 JSON，方便后续程序解析。
            "response_format": {"type": "json_object"},

            # 关闭 thinking，避免评估结果中混入额外推理内容。
            "thinking": {"type": "disabled"},

            # temperature 设置为 0，尽量让评估结果稳定。
            "temperature": 0,

            # 不使用流式输出，因为需要一次性拿到完整 JSON。
            "stream": False,
        },
        resolved_api_key,
    )

    # 从模型响应中取出文本内容。
    # 正常情况下，这里应该是一段 JSON 字符串。
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("Faithfulness 评估没有返回可用内容。") from error

    if not content:
        raise RuntimeError("Faithfulness 评估没有返回可用内容。")

    try:
        # 即使设置了 response_format，也必须防御模型返回非法 JSON。
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError(
            f"Faithfulness 评估没有返回合法 JSON：{content}"
        ) from error

    # 模型返回的是外部数据，不能直接相信。
    # 这里检查字段类型、支持关系，以及引用的 Chunk ID 是否真实存在。
    claims = validate_claim_judgements(
        parsed, evaluation_case["retrievedChunks"]
    )

    # 统计有多少个 Claim 能被上下文支持。
    supported_count = sum(claim["supported"] for claim in claims)

    return {
        # Faithfulness = 有上下文支持的 Claim 数量 / 全部 Claim 数量。
        "score": supported_count / len(claims),
        "supportedCount": supported_count,
        "totalCount": len(claims),
        # 保留每个 Claim 的详细判断，方便继续定位答案问题。
        "claims": claims,
    }


def evaluate_retrieval(
    evaluation_case: dict[str, Any], k: int
) -> dict[str, float | None]:
    """计算单个案例的确定性检索指标。"""
    return {
        "recall": recall_at_k(
            evaluation_case["retrievedChunks"],
            evaluation_case["relevantChunkIds"],
            k,
        ),
        "reciprocalRank": reciprocal_rank(
            evaluation_case["retrievedChunks"],
            evaluation_case["relevantChunkIds"],
            k,
        ),
    }


def diagnose(metrics: dict[str, float | None]) -> str:
    """根据指标组合给出排查方向。"""
    # 这只是定位线索，不是绝对因果关系。
    recall = metrics["recall"]
    reciprocal_rank_value = metrics["reciprocalRank"]
    faithfulness = metrics["faithfulness"]

    if recall is not None and recall < 1:
        return "优先检查召回：分块、Embedding、Query Rewrite、BM25 或过滤条件"

    if reciprocal_rank_value is not None and reciprocal_rank_value < 1:
        return "优先检查排序：融合策略、RRF、Weighted 或 Rerank"

    if faithfulness is None:
        return "召回和排序正常；需要完整模式继续检查答案 Faithfulness"

    if faithfulness < 1:
        return "优先检查生成：Prompt、上下文噪声和答案约束"

    return "当前案例的召回、排序和生成指标均正常"

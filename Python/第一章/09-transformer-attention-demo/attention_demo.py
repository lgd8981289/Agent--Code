"""手动计算一个简化版 Transformer Attention Head。"""

import math
from typing import Any


tokens = [
    "订单",
    "A1024",
    "退款金额",
    "3000",
    "元",
    "超过",
    "2000",
    "元",
    "需要",
    "人工审核",
]

features = {
    "订单": [0, 0, 0, 0, 1],
    "A1024": [0, 0, 0, 0, 1],
    "退款金额": [1, 0, 0, 0, 0],
    "3000": [1, 0, 0, 0, 0],
    "元": [0.4, 0.4, 0, 0, 0],
    "超过": [0, 0, 1, 0, 0],
    "2000": [0, 1, 0, 0, 0],
    "需要": [0, 0, 1, 1, 0],
    "人工审核": [0.5, 0.5, 1, 1, 0],
}

head = {
    "name": "金额审核关系头",
    "queryWeights": [1, 1, 1, 1, 0],
    "keyWeights": [1, 1, 1, 0.8, 0],
    "valueWeights": [1, 1, 1, 1, 0],
}


def project(vector: list[float], weights: list[float]) -> list[float]:
    """使用逐元素乘法模拟向量投影。"""
    return [value * weight for value, weight in zip(vector, weights)]


def dot(first: list[float], second: list[float]) -> float:
    """计算两个向量的点积。"""
    return sum(a * b for a, b in zip(first, second))


def softmax(scores: list[float]) -> list[float]:
    """把相关性分数转换成注意力权重。"""
    max_score = max(scores)
    exponentials = [math.exp(score - max_score) for score in scores]
    total = sum(exponentials)
    return [value / total for value in exponentials]


def weighted_sum(
    values: list[list[float]], weights: list[float]
) -> list[float]:
    """按照注意力权重汇总多个 Value 向量。"""
    result = [0.0] * len(values[0])
    for vector, weight in zip(values, weights):
        for index, value in enumerate(vector):
            result[index] += value * weight
    return result


def run_attention(target_token: str) -> dict[str, Any]:
    """对指定 Token 执行一次带因果遮罩的简化 Attention。"""
    target_index = tokens.index(target_token)
    visible_tokens = tokens[: target_index + 1]

    query = project(features[target_token], head["queryWeights"])
    keys = [
        project(features[token], head["keyWeights"])
        for token in visible_tokens
    ]
    values = [
        project(features[token], head["valueWeights"])
        for token in visible_tokens
    ]
    scores = [
        dot(query, key) / math.sqrt(len(query))
        for key in keys
    ]
    weights = softmax(scores)
    new_representation = weighted_sum(values, weights)
    attention_list = sorted(
        [
            {"token": token, "weight": weights[index]}
            for index, token in enumerate(visible_tokens)
        ],
        key=lambda item: item["weight"],
        reverse=True,
    )

    return {
        "query": query,
        "attentionList": attention_list,
        "newRepresentation": new_representation,
    }


def run_demo() -> dict[str, Any]:
    """观察“人工审核”会关注哪些前文 Token。"""
    result = run_attention("人工审核")
    print(f"Attention Head：{head['name']}")
    print("目标 Token：人工审核")
    print("Query：", [f"{value:.2f}" for value in result["query"]])

    print("\n注意力权重 Top 6：")
    for item in result["attentionList"][:6]:
        print(f"{item['token']}: {item['weight'] * 100:.2f}%")

    print("\n加权汇总 Value 后，得到的新表示：")
    print([f"{value:.3f}" for value in result["newRepresentation"]])
    return result


if __name__ == "__main__":
    run_demo()

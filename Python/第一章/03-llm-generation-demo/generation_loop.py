"""模拟大模型逐个生成 Token 的过程。"""

import math


# candidate_map 用来模拟：在不同上下文下，模型可能生成的候选 Token
# 及其 Logit 分数。
#
# 字典的 key 表示“当前上下文”，value 表示“候选 Token 列表”。
# 每个候选项的格式是：(候选 Token, Logit 分数)。
candidate_map: dict[str, list[tuple[str, float]]] = {
    "周末我准备": [
        ("学习", 3.2),
        ("休息", 2.6),
        ("出门", 2.1),
    ],
    "周末我准备学习": [
        (" Agent", 3.8),
        (" Node.js", 2.7),
        ("英语", 1.6),
    ],
    "周末我准备学习 Agent": [
        ("。", 3.1),
        ("开发", 2.4),
        ("相关知识", 1.8),
    ],
    "周末我准备学习 Agent。": [
        ("<EOS>", 4.2),
        ("然后", 1.1),
    ],
}


def softmax(
    candidates: list[tuple[str, float]],
) -> list[tuple[str, float]]:
    """将候选 Token 的 Logit 分数转换成概率分布。"""
    # 减去最大 Logit 可以避免指数运算时出现数值溢出，
    # 同时不会改变最终的概率比例。
    max_logit = max(logit for _, logit in candidates)

    exponential_items = [
        (token, math.exp(logit - max_logit))
        for token, logit in candidates
    ]
    total = sum(value for _, value in exponential_items)

    return [
        (token, value / total)
        for token, value in exponential_items
    ]


def choose_highest(
    probabilities: list[tuple[str, float]],
) -> tuple[str, float]:
    """使用贪心策略，选择概率最高的 Token。"""
    return max(probabilities, key=lambda item: item[1])


def print_probabilities(probabilities: list[tuple[str, float]]) -> None:
    """打印当前步骤的候选 Token 和概率。"""
    print("候选内容\t概率")
    for token, probability in probabilities:
        print(f"{token}\t{probability * 100:.2f}%")


def generate(
    initial_context: str = "周末我准备",
    max_steps: int = 10,
    *,
    verbose: bool = True,
) -> str:
    """按候选表逐步生成 Token，并返回最终上下文。"""
    context = initial_context

    for step in range(1, max_steps + 1):
        candidates = candidate_map.get(context)

        if candidates is None:
            if verbose:
                print("没有更多候选内容，生成结束。")
            break

        probabilities = softmax(candidates)
        selected_token, _ = choose_highest(probabilities)

        if verbose:
            print(f"\n第 {step} 步")
            print(f"当前上下文：{context}")
            print_probabilities(probabilities)
            print(f"本次选择：{selected_token}")

        if selected_token == "<EOS>":
            if verbose:
                print("模型生成了结束标记，生成结束。")
            break

        context += selected_token

    if verbose:
        print(f"\n最终内容：{context}")

    return context


if __name__ == "__main__":
    generate()

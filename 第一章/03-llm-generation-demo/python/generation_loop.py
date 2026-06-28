"""用一个可观察的小例子，模拟大模型逐个生成 Token 的过程。"""

import math


# candidate_map 用来模拟：在不同上下文下，模型可能生成的候选 Token 及其 Logit 分数
# dict 的 key 表示“当前上下文”
# dict 的 value 表示“候选 Token 列表”
# 每个候选项的格式是：(候选 Token, Logit 分数)
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
    if not candidates:
        raise ValueError("候选 Token 列表不能为空。")

    # 找出最大的 Logit。
    # 这里用它做数值稳定处理，避免 math.exp(logit) 计算时数值过大。
    max_logit = max(logit for _, logit in candidates)

    # 对每个 Logit 做指数运算。
    # logit - max_logit 不会改变最终 softmax 的概率比例，
    # 但可以避免指数运算时出现数值溢出。
    items = [
        (token, math.exp(logit - max_logit))
        for token, logit in candidates
    ]

    # 计算所有指数值的总和。
    # 后面需要用每一项除以总和，得到归一化概率。
    total = sum(value for _, value in items)

    # 返回每个候选 Token 对应的概率。
    return [(token, value / total) for token, value in items]


def choose_highest(
    probabilities: list[tuple[str, float]],
) -> tuple[str, float]:
    """使用贪心策略，选择当前概率最高的 Token。"""
    if not probabilities:
        raise ValueError("概率列表不能为空。")

    return max(probabilities, key=lambda item: item[1])


def print_probabilities(probabilities: list[tuple[str, float]]) -> None:
    """逐行打印候选 Token 及其概率。"""
    print("候选 Token 概率：")

    for token, probability in probabilities:
        # repr 可以让以空格开头的 Token 更容易被观察到。
        print(f"- {token!r}：{probability:.2%}")


def generate(initial_context: str, max_steps: int = 10) -> str:
    """从初始上下文开始，最多生成 max_steps 个 Token。"""
    context = initial_context

    for step in range(1, max_steps + 1):
        # 根据当前上下文，查找对应的候选 Token 列表。
        candidates = candidate_map.get(context)

        # 如果当前上下文没有对应的候选内容，
        # 说明模拟数据中已经没有后续可生成的内容了。
        if candidates is None:
            print("没有更多候选内容，生成结束。")
            break

        # 把候选 Token 的 Logit 分数转换成概率。
        probabilities = softmax(candidates)

        # 从概率分布中选择概率最高的 Token。
        selected_token, _ = choose_highest(probabilities)

        print(f"\n第 {step} 步")
        print(f"当前上下文：{context}")
        print_probabilities(probabilities)
        print(f"本次选择：{selected_token}")

        # <EOS> 表示 End Of Sequence，也就是“结束标记”。
        # 如果模型生成了 <EOS>，说明本次生成应该停止。
        if selected_token == "<EOS>":
            print("模型生成了结束标记，生成结束。")
            break

        # 将本次选择的 Token 拼接到上下文后面。
        # 下一轮生成时，模型会基于更新后的上下文继续预测下一个 Token。
        context += selected_token

    return context


def main() -> None:
    """运行生成演示并打印最终内容。"""
    final_content = generate(initial_context="周末我准备")
    print(f"\n最终内容：{final_content}")


if __name__ == "__main__":
    main()

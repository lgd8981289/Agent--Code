"""运行固定 RAG 评估集并打印 Recall@K、MRR 与 Faithfulness。"""

import sys
from typing import Any

from evaluation_cases import evaluation_cases
from rag_evaluator import (
    diagnose,
    evaluate_faithfulness,
    evaluate_retrieval,
    mean,
)


TOP_K = 3


def run_evaluation(mode: str) -> list[dict[str, Any]]:
    """按照指定模式运行全部评估案例。"""
    if mode not in {"retrieval", "full"}:
        raise ValueError("运行模式只能是 retrieval 或 full。")

    results: list[dict[str, Any]] = []

    for evaluation_case in evaluation_cases:
        # Recall@K 和 RR 完全由固定标注与检索结果计算，不需要调用模型。
        retrieval = evaluate_retrieval(evaluation_case, TOP_K)

        # full 模式才调用评估模型判断 Faithfulness。
        faithfulness_result = (
            evaluate_faithfulness(evaluation_case)
            if mode == "full"
            else None
        )
        faithfulness = (
            faithfulness_result["score"]
            if faithfulness_result is not None
            else None
        )

        result = {
            "id": evaluation_case["id"],
            "name": evaluation_case["name"],
            "question": evaluation_case["question"],
            **retrieval,
            "faithfulness": faithfulness,
            "claims": (
                faithfulness_result["claims"]
                if faithfulness_result is not None
                else []
            ),
            "diagnosis": diagnose(
                {
                    **retrieval,
                    "faithfulness": faithfulness,
                }
            ),
        }
        results.append(result)

    return results


def print_results(
    results: list[dict[str, Any]], mode: str
) -> None:
    """打印每个案例和整个评估集的指标。"""
    print(f"评估模式：{'完整评估' if mode == 'full' else '仅检索指标'}")
    print(f"TopK：{TOP_K}")

    for result in results:
        print(f"\n================ {result['name']} ================")
        print(f"问题：{result['question']}")

        recall = result["recall"]
        recall_text = "N/A" if recall is None else f"{recall:.6f}"
        print(f"Recall@{TOP_K}：{recall_text}")
        print(f"RR@{TOP_K}：{result['reciprocalRank']:.6f}")

        if result["faithfulness"] is not None:
            print(f"Faithfulness：{result['faithfulness']:.6f}")
            print("Claim 判断：")

            for claim in result["claims"]:
                status = "支持" if claim["supported"] else "不支持"
                print(f"- [{status}] {claim['claim']}")

        print(f"定位建议：{result['diagnosis']}")

    # 没有人工相关性标注的案例不参与 Mean Recall@K 统计。
    valid_recall_values = [
        result["recall"]
        for result in results
        if result["recall"] is not None
    ]
    mean_recall = mean(valid_recall_values)
    mrr = mean([result["reciprocalRank"] for result in results])

    print("\n================ 整体指标 ================")
    print(f"Mean Recall@{TOP_K}：{mean_recall:.6f}")
    print(f"MRR@{TOP_K}：{mrr:.6f}")

    if mode == "full":
        mean_faithfulness = mean(
            [
                result["faithfulness"]
                for result in results
                if result["faithfulness"] is not None
            ]
        )
        print(f"Mean Faithfulness：{mean_faithfulness:.6f}")


def main() -> None:
    """读取命令行模式，运行评估并输出结果。"""
    mode = sys.argv[1] if len(sys.argv) > 1 else "retrieval"
    results = run_evaluation(mode)
    print_results(results, mode)


if __name__ == "__main__":
    main()

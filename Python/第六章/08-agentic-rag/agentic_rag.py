"""Agentic RAG 演示入口。"""

from __future__ import annotations

import sys
from typing import Any

from fixtures import now, principal, scenarios
from models import create_model_services
from workflow import create_agentic_rag_graph


def print_result(scenario_name: str, question: str, result: dict[str, Any]) -> None:
    """打印一次 Agentic RAG 的执行结果。"""

    print("\n================ Agentic RAG Demo ================")
    print(f"场景：{scenario_name}")
    print(f"问题：{question}")

    print("\n--- Trace ---")
    for index, item in enumerate(result.get("trace", []), start=1):
        print(f"{index}. {item}")

    print("\n--- Final ---")
    print(f"outcome：{result.get('outcome')}")
    print(f"searchAttempts：{result.get('searchAttempts', 0)}")
    print(f"answer：{result.get('finalAnswer')}")

    source_ids = set(result.get("sourceIds", []))
    sources = [
        chunk for chunk in result.get("usableEvidence", []) if chunk["id"] in source_ids
    ]

    if sources:
        print("\n--- Sources ---")
        for source in sources:
            print(f"- {source['id']}｜{source['title']}｜{source['content']}")


def main() -> None:
    scenario_name = sys.argv[1] if len(sys.argv) > 1 else "multi"
    scenario = scenarios.get(scenario_name)

    if not scenario:
        available = "、".join(scenarios.keys())
        raise RuntimeError(f"未知场景：{scenario_name}。可选值：{available}。")

    graph = create_agentic_rag_graph(
        services=create_model_services(),
        principal=principal,
        now=now,
        max_searches=3,
    )

    result = graph.invoke(
        {
            "question": scenario["question"],
        }
    )

    print_result(scenario_name, scenario["question"], result)


if __name__ == "__main__":
    main()

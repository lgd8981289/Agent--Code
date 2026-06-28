"""演示 Retrieval、Augmentation、Generation 三个 RAG 步骤。"""

import json
import os
from pprint import pprint
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from knowledge_base import knowledge_base


ChatRequester = Callable[[dict[str, Any], str], dict[str, Any]]


def retrieve(question: str, limit: int = 1) -> list[dict[str, Any]]:
    """根据关键词命中数量排序，返回最相关的前 limit 篇资料。"""
    scored_documents: list[dict[str, Any]] = []

    for document in knowledge_base:
        # 找出当前文档中，被用户问题命中的关键词。
        matched_keywords = [
            keyword
            for keyword in document["keywords"]
            if keyword in question
        ]

        # 只保留至少命中一个关键词的文档。
        if matched_keywords:
            scored_documents.append(
                {
                    **document,
                    "score": len(matched_keywords),
                    "matchedKeywords": matched_keywords,
                }
            )

    # 命中关键词越多，文档分数越高。
    scored_documents.sort(key=lambda document: document["score"], reverse=True)
    return scored_documents[:limit]


def build_context(documents: list[dict[str, Any]]) -> str:
    """把检索结果整理成模型可以阅读的参考资料。"""
    if not documents:
        return "未提供任何企业资料。"

    return "\n\n".join(
        f"[{document['title']}]\n{document['content']}"
        for document in documents
    )


def request_chat_completion(
    request_body: dict[str, Any], api_key: str
) -> dict[str, Any]:
    """使用 Python 标准库调用 DeepSeek Chat Completions API。"""
    request = Request(
        "https://api.deepseek.com/chat/completions",
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
            f"DeepSeek API 调用失败：{error.code} {error_text}"
        ) from error


def call_model(
    *,
    question: str,
    documents: list[dict[str, Any]],
    demo_reply: str,
    api_key: str | None = None,
    requester: ChatRequester = request_chat_completion,
) -> str:
    """让模型只根据参考资料回答；没有 Key 时返回演示回答。"""
    context = build_context(documents)
    messages = [
        {
            "role": "system",
            "content": (
                "你是星河零售公司的知识助手。只能根据参考资料回答。"
                "资料不足时，必须明确回答“根据当前资料无法判断”，"
                "不要编造公司规则。"
            ),
        },
        {
            "role": "user",
            "content": f"参考资料：\n{context}\n\n用户问题：\n{question}",
        },
    ]

    print("\n本次交给模型的参考资料：")
    print(context)

    resolved_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
    if not resolved_api_key:
        print("\n没有检测到 DEEPSEEK_API_KEY，使用演示回答：")
        print(demo_reply)
        return demo_reply

    result = requester(
        {
            "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
            "messages": messages,
            "stream": False,
        },
        resolved_api_key,
    )

    try:
        answer = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("DeepSeek API 没有返回可用的回答。") from error

    print("\n模型回答：")
    print(answer)
    return answer


question = "用户购买了一台 3000 元的咖啡机，签收 3 天后申请退款，是否需要人工审核？"


def run_demo() -> dict[str, Any]:
    """依次运行无资料、手动资料和检索资料三个实验。"""
    print("\n================ 实验一：不提供企业资料 ================")
    first_answer = call_model(
        question=question,
        documents=[],
        demo_reply="根据当前资料无法判断。",
    )

    print("\n================ 实验二：手动补充退款规则 ================")
    second_answer = call_model(
        question=question,
        documents=[knowledge_base[0]],
        demo_reply="需要人工审核，因为退款金额 3000 元超过了 2000 元。",
    )

    print("\n================ 实验三：先检索，再回答 ================")
    retrieved_documents = retrieve(question)

    print("\n检索结果：")
    pprint(
        [
            {
                "id": document["id"],
                "title": document["title"],
                "score": document["score"],
                "matchedKeywords": "、".join(document["matchedKeywords"]),
            }
            for document in retrieved_documents
        ],
        sort_dicts=False,
    )

    third_answer = call_model(
        question=question,
        documents=retrieved_documents,
        demo_reply="需要人工审核，因为退款金额 3000 元超过了 2000 元。",
    )
    return {
        "answers": [first_answer, second_answer, third_answer],
        "retrievedDocuments": retrieved_documents,
    }


if __name__ == "__main__":
    run_demo()

"""
精确读取画像、检索历史记忆并组织本次模型输入。

本文件对应 Node 版的 memory-recall.js。
"""

from __future__ import annotations

import sys
from typing import Any

from langgraph.store.memory import InMemoryStore

from fixtures import current_facts, now, principal, question, thread_state
from models import ZhipuEmbeddings, create_answer_model
from recall import (
    build_model_input,
    get_current_decision,
    load_answer_preferences,
    recall_events,
    seed_store,
)


def main(mode: str | None = None) -> None:
    """完整演示一次“记忆召回 → Context 组装 → 模型调用”的过程。

    demo 模式：
    - 执行真实向量召回
    - 打印召回决策、最终记忆和模型输入
    - 不真正调用大模型

    answer 模式：
    - 在 demo 模式基础上
    - 继续调用 DeepSeek 生成最终回答
    """

    # 从命令行读取运行模式，未指定时默认只演示召回过程。
    mode = mode or (sys.argv[1] if len(sys.argv) > 1 else "demo")

    # 只允许 demo 和 answer 两种模式，避免传入未定义的执行路径。
    if mode not in ["demo", "answer"]:
        raise RuntimeError("可用模式：demo、answer。")

    # 创建 Embedding 模型。
    #
    # Store 会使用它把记忆 content 转换成向量，
    # 后续根据用户问题进行语义相似度检索。
    embeddings = ZhipuEmbeddings()

    # 创建支持向量检索的内存 Store。
    #
    # index：
    # - embed：负责生成向量
    # - dims：Embedding 向量维度
    # - fields：指定哪些字段参与向量索引
    #
    # 这里仅对 memory.value.content 建立语义索引。
    store = InMemoryStore(
        index={
            "embed": embeddings,
            "dims": embeddings.dimensions,
            "fields": ["content"],
        }
    )

    # 写入本案例预设的用户偏好、历史事件等测试记忆。
    seed_store(store, principal)

    print(f"\n========== 本次问题 ==========\n{question}")

    # 精确读取用户的回答偏好。
    #
    # 这类稳定配置已经有明确 Key，
    # 不需要通过向量相似度搜索，直接按 Namespace + Key 获取即可。
    preferences = load_answer_preferences(store, principal, now)

    print("\n========== 精确读取的回答偏好 ==========")
    print(preferences)

    # 根据当前问题召回相关历史事件。
    #
    # recall_events 内部不仅进行向量检索，
    # 还会继续判断候选记忆是否仍然有效、是否适合进入本轮 Context。
    recalled = recall_events(store, principal, question, now=now)

    # 打印每一条历史记忆候选的召回决策。
    #
    # decisions 用于观察：
    # - 哪些记忆被检索出来
    # - 哪些最终被保留或过滤
    # - 保留 / 过滤的具体原因
    print("\n========== 历史记忆候选与筛选原因 ==========")
    for decision in recalled["decisions"]:
        print(decision)

    # selected 才是真正允许进入本轮模型 Context 的历史记忆。
    print("\n========== 最终入选的历史记忆 ==========")
    print(recalled["selected"])

    # 读取与当前问题相关的“当前事实”。
    #
    # 历史 Memory 代表过去保存的信息；
    # current_facts 代表业务系统当前状态。
    #
    # 当两者发生冲突时，通常应该优先相信更新的当前事实。
    current_decision = get_current_decision(current_facts, principal, now)

    # 组装本轮真正发送给模型的 messages。
    #
    # 输入可能同时包含：
    # - Thread 当前会话状态
    # - 用户本次问题
    # - 精确读取的回答偏好
    # - 召回并筛选后的长期记忆
    # - 当前业务事实
    #
    # 也就是说：
    # “Store 中存在某条记忆”并不代表它一定会进入模型 Context。
    messages = build_model_input(
        state=thread_state,
        question=question,
        preferences=preferences,
        memories=recalled["selected"],
        current_decision=current_decision,
    )

    # 打印最终模型输入。
    #
    # 这一部分非常重要，因为真正影响模型回答的，
    # 不是 Store 里保存了什么，而是最终 messages 中实际包含了什么。
    print("\n========== 本次真正准备发送的 messages ==========")

    for index, message in enumerate(messages):
        print(f"\n[{index}] {message['role']}\n{message['content']}")

    # answer 模式才真正调用 DeepSeek。
    #
    # demo 模式停留在 Context 构造阶段，
    # 方便单独观察和调试 Memory 的召回行为。
    if mode == "answer":
        response = create_answer_model().invoke(messages)

        print("\n========== DeepSeek 回答 ==========")
        print(response.content)
    else:
        print("\n当前只运行真实向量召回。执行 python memory_recall.py answer 可继续调用 DeepSeek。")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)

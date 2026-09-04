"""
不调用大模型，只验证 Store 的核心存储机制。

主要观察：

1. Namespace：决定数据存放在哪个逻辑空间；
2. Key：决定 Namespace 下具体哪一条数据；
3. Value：真正保存的用户画像内容；
4. 跨 Thread：验证 Store 中的数据可以被其他 Thread 继续读取。
"""

from __future__ import annotations

from langgraph.store.memory import InMemoryStore

from profile_store import load_user_profile, profile_namespace, save_user_profile


USER_ONE = {
    "tenantId": "bluewhale",
    "userId": "user-1001",
}


USER_TWO = {
    "tenantId": "bluewhale",
    "userId": "user-1002",
}


def main() -> None:
    # 创建内存 Store。
    # InMemoryStore 适合用于本地实验，数据只保存在当前进程内存中。
    store = InMemoryStore()

    print("\n========== Thread A：保存用户画像 ==========")
    print("Namespace：", profile_namespace(USER_ONE))
    print("Key：current")

    # 写入 USER_ONE 的长期用户画像。
    # 最终可以理解为：
    #
    # Namespace + Key -> Value
    #
    # profile_namespace(USER_ONE) + "current"
    #              ↓
    #        用户画像对象
    save_user_profile(
        store,
        USER_ONE,
        {
            "responseLanguage": "zh-CN",
            "answerStyle": "conclusion_first",
            "contactWindow": "工作日 19:00 以后",
        },
    )

    # Thread B：
    # 模拟新的会话 Thread。
    #
    # 虽然已经不是 Thread A，
    # 但只要使用的是同一个 Store，并且 Namespace + Key 相同，
    # 依然能够读取之前保存的用户画像。
    print("\n========== Thread B：同一用户读取 ==========")
    print(load_user_profile(store, USER_ONE))

    # Thread C：
    # 换成另一个用户 USER_TWO 读取。
    #
    # USER_TWO 会使用自己的 Namespace，
    # 因此不会读取到 USER_ONE 保存的用户画像，
    # 用来验证不同用户之间的数据隔离。
    print("\n========== Thread C：另一名用户读取 ==========")
    print(load_user_profile(store, USER_TWO))


if __name__ == "__main__":
    main()

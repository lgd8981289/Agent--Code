from __future__ import annotations

from datetime import datetime, timedelta
import unittest

from langgraph.store.memory import InMemoryStore

from memory_manager import (
    apply_memory_candidate,
    forget_memory,
    get_active_memory,
    memory_namespace,
    recall_memories,
    to_js_iso,
)
from scenarios import candidates, principal


now = datetime.fromisoformat("2026-09-06T12:00:00+08:00")
options = {"now": now}


def seed() -> InMemoryStore:
    store = InMemoryStore()
    apply_memory_candidate(store, principal, candidates["initial"], **options)
    return store


class DeleteFailureStore:
    """测试用 Store 代理：只让 delete 失败，其余行为委托给真实 InMemoryStore。"""

    def __init__(self, store: InMemoryStore):
        self.store = store
        self.fail_delete = True

    def get(self, *args, **kwargs):
        return self.store.get(*args, **kwargs)

    def put(self, *args, **kwargs):
        return self.store.put(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if self.fail_delete:
            raise RuntimeError("模拟存储异常")

        return self.store.delete(*args, **kwargs)

    def search(self, *args, **kwargs):
        return self.store.search(*args, **kwargs)


class MemoryManagerTest(unittest.TestCase):
    def test_alias_and_duplicate_processing_does_not_create_new_item_or_revision(self):
        store = seed()

        for candidate in [candidates["initial"], candidates["repeat"]]:
            result = apply_memory_candidate(store, principal, candidate, **options)
            self.assertEqual(result["action"], "duplicate")

        items = store.search(memory_namespace(principal))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].value["revision"], 1)

    def test_current_thread_python_requirement_does_not_override_long_term_runtime(self):
        store = seed()

        self.assertEqual(
            apply_memory_candidate(
                store,
                principal,
                candidates["temporary"],
                **options,
            )["action"],
            "current_thread_only",
        )
        self.assertEqual(
            get_active_memory(store, principal, "preferred_runtime", now)["value"],
            "Node.js",
        )

    def test_conflict_keeps_old_value_then_updates_same_key_after_confirmation(self):
        store = seed()
        apply_memory_candidate(store, principal, candidates["language"], **options)

        conflict = apply_memory_candidate(
            store,
            principal,
            candidates["correction"],
            **options,
        )

        self.assertEqual(conflict["action"], "needs_confirmation")
        self.assertEqual(
            get_active_memory(store, principal, "preferred_runtime", now)["value"],
            "Node.js",
        )

        apply_memory_candidate(
            store,
            principal,
            candidates["correction"],
            now=now,
            confirmed_revision=conflict["currentRevision"],
        )

        memories = recall_memories(store, principal, now)
        self.assertEqual(
            [
                {
                    "key": memory["key"],
                    "value": memory["value"],
                    "revision": memory["revision"],
                }
                for memory in memories
            ],
            [
                {
                    "key": "preferred_language",
                    "value": "TypeScript",
                    "revision": 1,
                },
                {
                    "key": "preferred_runtime",
                    "value": "Python",
                    "revision": 2,
                },
            ],
        )

    def test_late_old_source_and_stale_confirmation_cannot_override_corrected_memory(
        self,
    ):
        store = seed()

        apply_memory_candidate(
            store,
            principal,
            candidates["correction"],
            now=now,
            confirmed_revision=1,
        )

        self.assertEqual(
            apply_memory_candidate(
                store,
                principal,
                candidates["repeat"],
                **options,
            )["action"],
            "stale_source",
        )
        self.assertEqual(
            apply_memory_candidate(
                store,
                principal,
                candidates["correction"],
                now=now,
                confirmed_revision=1,
            )["action"],
            "stale_confirmation",
        )
        self.assertEqual(
            get_active_memory(store, principal, "preferred_runtime", now)["value"],
            "Python",
        )

    def test_expiry_boundary_stops_returning_but_keeps_physical_store_record(self):
        store = InMemoryStore()
        apply_memory_candidate(store, principal, candidates["contact"], **options)

        expiry = datetime.fromisoformat(candidates["contact"]["expiresAt"])

        self.assertIsNotNone(
            get_active_memory(
                store,
                principal,
                "contact_window",
                expiry - timedelta(milliseconds=1),
            )
        )
        self.assertIsNone(get_active_memory(store, principal, "contact_window", expiry))
        self.assertIsNotNone(store.get(memory_namespace(principal), "contact_window"))
        self.assertEqual(recall_memories(store, principal, expiry), [])
        self.assertEqual(
            apply_memory_candidate(
                store,
                principal,
                candidates["contact"],
                now=expiry,
            )["action"],
            "expired_candidate",
        )

    def test_repeated_message_does_not_extend_expiry_without_confirmation(self):
        store = InMemoryStore()
        apply_memory_candidate(store, principal, candidates["contact"], **options)

        extension = {
            **candidates["contact"],
            "expiresAt": "2026-09-10T00:00:00+08:00",
            "source": {
                **candidates["contact"]["source"],
                "messageId": "msg-6",
                "observedAt": "2026-09-06T10:00:00+08:00",
            },
        }

        self.assertEqual(
            apply_memory_candidate(store, principal, extension, **options)["action"],
            "needs_confirmation",
        )
        self.assertEqual(
            get_active_memory(store, principal, "contact_window", now)["expiresAt"],
            candidates["contact"]["expiresAt"],
        )

    def test_deletion_clears_body_blocks_old_candidates_and_keeps_other_memory(self):
        store = seed()
        apply_memory_candidate(store, principal, candidates["language"], **options)
        forget_memory(store, principal, "preferred_runtime", now)

        self.assertIsNone(store.get(memory_namespace(principal), "preferred_runtime"))

        block = store.get(
            memory_namespace(principal, "lifecycle-blocks"),
            "preferred_runtime",
        )
        self.assertEqual(block.value, {"blockedAt": to_js_iso(now)})

        for candidate in [candidates["initial"], candidates["correction"]]:
            self.assertEqual(
                apply_memory_candidate(store, principal, candidate, **options)[
                    "action"
                ],
                "blocked_by_deletion",
            )

        self.assertIsNone(
            get_active_memory(store, principal, "preferred_runtime", now)
        )
        self.assertEqual(len(recall_memories(store, principal, now)), 1)

    def test_failed_physical_delete_already_blocks_normal_read_write_and_can_retry(self):
        store = DeleteFailureStore(seed())

        with self.assertRaisesRegex(RuntimeError, "模拟存储异常"):
            forget_memory(store, principal, "preferred_runtime", now)

        self.assertIsNone(
            get_active_memory(store, principal, "preferred_runtime", now)
        )
        self.assertEqual(
            apply_memory_candidate(
                store,
                principal,
                candidates["repeat"],
                **options,
            )["action"],
                "blocked_by_deletion",
        )

        store.fail_delete = False
        forget_memory(store, principal, "preferred_runtime", now)
        self.assertIsNone(store.get(memory_namespace(principal), "preferred_runtime"))

    def test_user_and_tenant_memory_and_deletion_blocks_are_isolated(self):
        store = seed()

        for other in [
            {**principal, "userId": "user-1002"},
            {**principal, "tenantId": "xinghe"},
        ]:
            self.assertEqual(recall_memories(store, other, now), [])
            apply_memory_candidate(store, other, candidates["initial"], **options)

        forget_memory(store, principal, "preferred_runtime", now)
        self.assertEqual(
            get_active_memory(
                store,
                {**principal, "tenantId": "xinghe"},
                "preferred_runtime",
                now,
            )["value"],
            "Node.js",
        )

    def test_rejects_unknown_memory_key_and_future_source_time(self):
        store = InMemoryStore()

        with self.assertRaises(ValueError):
            apply_memory_candidate(
                store,
                principal,
                {
                    **candidates["initial"],
                    "key": "company_refund_threshold",
                },
                **options,
            )

        with self.assertRaisesRegex(RuntimeError, "来源消息时间"):
            apply_memory_candidate(
                store,
                principal,
                {
                    **candidates["initial"],
                    "source": {
                        **candidates["initial"]["source"],
                        "observedAt": "2027-01-01T00:00:00Z",
                    },
                },
                **options,
            )


if __name__ == "__main__":
    unittest.main()

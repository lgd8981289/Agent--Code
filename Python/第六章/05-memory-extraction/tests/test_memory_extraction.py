from __future__ import annotations

import contextlib
import io
import os
import unittest
from uuid import UUID

from langgraph.store.memory import InMemoryStore

from conversation import conversation, principal, replay_candidates
from memory_extraction import main
from memory_extractor import (
    CandidateSchema,
    MemoryCandidate,
    create_memory_extractor,
    extract_memory_candidates,
)
from memory_policy import review_memory_candidate, review_memory_candidates
from memory_store import memory_namespace, save_accepted_memories


class FakeExtractor:
    def __init__(self, response):
        self.response = response
        self.messages = None

    def invoke(self, messages):
        self.messages = messages
        return self.response


class MemoryExtractionTest(unittest.TestCase):
    def test_only_accepts_user_long_term_non_sensitive_candidates(self):
        reviews = review_memory_candidates(
            replay_candidates,
            conversation,
            {"memoryEnabled": True},
        )

        self.assertEqual(
            [review["decision"]["code"] for review in reviews],
            [
                "ACCEPTED",
                "UNTRUSTED_SOURCE",
                "NOT_LONG_TERM",
                "NOT_LONG_TERM",
                "SENSITIVE_DATA",
            ],
        )

    def test_candidates_cannot_be_written_without_memory_consent(self):
        decision = review_memory_candidate(
            replay_candidates[0],
            conversation,
            {"memoryEnabled": False},
        )

        self.assertFalse(decision["accepted"])
        self.assertEqual(decision["code"], "MEMORY_DISABLED")

    def test_evidence_quote_must_exist_in_source_message(self):
        decision = review_memory_candidate(
            {
                **replay_candidates[0],
                "evidenceQuote": "用户明确表示自己精通 Java",
            },
            conversation,
            {"memoryEnabled": True},
        )

        self.assertFalse(decision["accepted"])
        self.assertEqual(decision["code"], "MISSING_EVIDENCE")

    def test_phone_and_card_like_values_are_sensitive(self):
        for text in [
            "用户手机号是 13800138000。",
            "用户银行卡号是 6222020202020202020。",
        ]:
            decision = review_memory_candidate(
                {
                    "content": text,
                    "category": "fact",
                    "duration": "long_term",
                    "sourceMessageId": "msg-1",
                    "evidenceQuote": "我平时使用 TypeScript 开发",
                },
                conversation,
                {"memoryEnabled": True},
            )

            self.assertEqual(decision["code"], "SENSITIVE_DATA")

    def test_save_accepted_memories_writes_only_accepted_candidates(self):
        store = InMemoryStore()
        reviews = review_memory_candidates(
            replay_candidates,
            conversation,
            {"memoryEnabled": True},
        )

        saved = save_accepted_memories(store, principal, reviews)

        self.assertEqual(len(saved), 1)
        UUID(saved[0]["key"])
        self.assertEqual(
            saved[0]["value"]["content"],
            "用户日常使用 TypeScript 开发，后续项目默认使用 Node.js。",
        )
        self.assertEqual(saved[0]["value"]["category"], "preference")
        self.assertEqual(saved[0]["value"]["sourceMessageId"], "msg-1")
        self.assertIn("createdAt", saved[0]["value"])

    def test_memory_namespace_matches_node_path_values(self):
        self.assertEqual(
            memory_namespace(principal),
            (
                "agent-course",
                "tenants",
                "bluewhale",
                "users",
                "user-1001",
                "extracted-memories",
            ),
        )

    def test_extract_memory_candidates_uses_structured_prompt(self):
        response = CandidateSchema(
            candidates=[
                MemoryCandidate(
                    content="用户日常使用 TypeScript 开发，后续项目默认使用 Node.js。",
                    category="preference",
                    duration="long_term",
                    sourceMessageId="msg-1",
                    evidenceQuote="我平时使用 TypeScript 开发，后续项目默认使用 Node.js。",
                )
            ]
        )
        extractor = FakeExtractor(response)

        candidates = extract_memory_candidates(extractor, conversation)

        self.assertEqual(candidates, [response.candidates[0].model_dump()])
        self.assertEqual(extractor.messages[0]["role"], "system")
        self.assertIn("没有最终保存权限", extractor.messages[0]["content"])
        self.assertEqual(extractor.messages[1]["role"], "user")
        self.assertIn('"id": "msg-1"', extractor.messages[1]["content"])

    def test_replay_main_persists_one_accepted_memory(self):
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            saved = main("replay")

        self.assertEqual(len(saved), 1)
        self.assertIn("ACCEPTED", output.getvalue())
        self.assertIn("SENSITIVE_DATA", output.getvalue())

    def test_no_consent_main_persists_nothing(self):
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            saved = main("no-consent")

        self.assertEqual(saved, [])
        self.assertIn("MEMORY_DISABLED", output.getvalue())

    def test_create_memory_extractor_requires_api_key_without_reading_env_file(self):
        original_value = os.environ.pop("DEEPSEEK_API_KEY", None)

        try:
            with self.assertRaisesRegex(RuntimeError, "DEEPSEEK_API_KEY"):
                create_memory_extractor()
        finally:
            if original_value is not None:
                os.environ["DEEPSEEK_API_KEY"] = original_value


if __name__ == "__main__":
    unittest.main()

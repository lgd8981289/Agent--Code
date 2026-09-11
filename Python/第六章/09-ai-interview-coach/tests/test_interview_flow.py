from __future__ import annotations

import unittest

from auth import demo_users
from interview_graph import InterviewGraphService
from interview_service import InterviewService
from knowledge import InterviewKnowledgeService
from memory import InterviewMemoryService
from model_service import InterviewModelService
from storage import InMemoryStore


class InterviewFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.principal = dict(demo_users[0])
        self.storage = InMemoryStore()
        self.memories = InterviewMemoryService(self.storage)
        self.models = InterviewModelService()
        self.graph = InterviewGraphService(
            self.memories,
            InterviewKnowledgeService(),
            self.models,
        )
        self.interviews = InterviewService(self.graph, self.memories, self.models)

    def test_new_session_answer_next_and_review_session(self):
        session = self.interviews.create_session(
            self.principal,
            {
                "kind": "new",
                "mode": "replay",
            },
        )

        self.assertEqual(session["status"], "awaiting_answer")
        self.assertEqual(session["currentQuestion"]["id"], "memory-boundaries")
        self.assertEqual(session["messages"][0]["kind"], "question")

        answered = self.interviews.answer(
            self.principal,
            session["sessionId"],
            "它们都是保存聊天记录的。",
        )

        self.assertEqual(answered["status"], "turn_complete")
        self.assertEqual(answered["lastEvaluation"]["verdict"], "incorrect")
        self.assertEqual(
            [source["id"] for source in answered["evidence"]],
            ["LC-SHORT-TERM-MEMORY", "LC-LONG-TERM-MEMORY"],
        )
        self.assertTrue(
            any("save_memory：agent-memory 更新为 needs_review" in item for item in answered["trace"])
        )

        memories = self.memories.list_learning_memories(self.principal)
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0]["key"], "agent-memory")
        self.assertEqual(memories[0]["status"], "needs_review")

        next_state = self.interviews.next(self.principal, session["sessionId"])
        self.assertEqual(next_state["status"], "awaiting_answer")
        self.assertEqual(next_state["currentQuestion"]["id"], "memory-boundaries-followup")

        review = self.interviews.create_session(
            self.principal,
            {
                "kind": "review",
                "mode": "replay",
            },
        )

        self.assertEqual(review["currentQuestion"]["id"], "memory-boundaries-review")
        self.assertEqual(review["usedMemoryKeys"], ["agent-memory"])

    def test_forget_memory_blocks_future_auto_save_for_same_topic(self):
        self.memories.record_training_result(
            self.principal,
            {
                "topic": "agent-memory",
                "title": "短期记忆与长期记忆",
                "verdict": "incorrect",
                "answerSummary": "不完整回答",
                "questionId": "memory-boundaries",
                "sourceIds": ["LC-SHORT-TERM-MEMORY"],
                "struggled": True,
            },
        )

        self.memories.forget_learning_memory(self.principal, "agent-memory")
        blocked = self.memories.record_training_result(
            self.principal,
            {
                "topic": "agent-memory",
                "title": "短期记忆与长期记忆",
                "verdict": "incorrect",
                "answerSummary": "再次不完整回答",
                "questionId": "memory-boundaries",
                "sourceIds": ["LC-SHORT-TERM-MEMORY"],
                "struggled": True,
            },
        )

        self.assertIsNone(blocked)
        self.assertEqual(self.memories.list_learning_memories(self.principal), [])


if __name__ == "__main__":
    unittest.main()

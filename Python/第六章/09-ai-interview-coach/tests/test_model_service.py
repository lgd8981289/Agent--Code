from __future__ import annotations

import unittest

from knowledge import InterviewKnowledgeService
from model_service import InterviewModelService


PROFILE = {
    "experience": "3 年前端开发",
    "targetRole": "AI 应用开发工程师",
    "focusTopics": ["Agent Memory"],
    "answerStyle": "简洁",
}


class InterviewModelServiceReplayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.models = InterviewModelService()

    def test_replay_mode_identifies_incomplete_and_complete_answers(self):
        question = self.models.select_question(
            {
                "profile": PROFILE,
                "reviewMemory": None,
                "turnNumber": 0,
                "previousQuestion": None,
                "previousEvaluation": None,
            }
        )

        weak = self.models.evaluate("replay", question, "它们都是保存聊天记录的。")
        complete = self.models.evaluate(
            "replay",
            question,
            "Checkpointer 根据 thread_id 保存 State，Store 保存跨会话长期记忆。",
        )

        self.assertEqual(weak["verdict"], "incorrect")
        self.assertEqual(complete["verdict"], "correct")

    def test_selects_follow_up_when_previous_answer_is_incomplete(self):
        first = self.models.select_question(
            {
                "profile": PROFILE,
                "reviewMemory": None,
                "turnNumber": 0,
                "previousQuestion": None,
                "previousEvaluation": None,
            }
        )
        follow_up = self.models.select_question(
            {
                "profile": PROFILE,
                "reviewMemory": None,
                "turnNumber": 1,
                "previousQuestion": first,
                "previousEvaluation": {
                    "verdict": "partial",
                    "reason": "不完整",
                    "gaps": ["Store"],
                    "requiredEvidence": first["evidenceTypes"],
                },
            }
        )

        self.assertEqual(follow_up["id"], "memory-boundaries-followup")


class InterviewKnowledgeServiceTest(unittest.TestCase):
    def test_search_returns_only_requested_evidence_type(self):
        knowledge = InterviewKnowledgeService()
        result = knowledge.search("long_term_memory")

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "LC-LONG-TERM-MEMORY")


if __name__ == "__main__":
    unittest.main()

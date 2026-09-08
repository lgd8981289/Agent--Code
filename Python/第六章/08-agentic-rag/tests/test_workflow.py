from __future__ import annotations

import unittest

from fixtures import now, principal, scenarios
from workflow import create_agentic_rag_graph


class FakeServices:
    """离线测试使用的模型替身，不调用真实 API。"""

    def decide(self, question: str) -> dict:
        if "改写" in question:
            return {
                "route": "direct",
                "requiredEvidence": [],
                "clarificationQuestion": None,
                "reason": "文字改写不需要企业资料",
            }

        if "需要人工审核吗" in question and "3500" not in question:
            return {
                "route": "clarify",
                "requiredEvidence": [],
                "clarificationQuestion": "请补充本次申请退款的金额。",
                "reason": "缺少退款金额",
            }

        if "终身免费" in question:
            return {
                "route": "retrieve",
                "requiredEvidence": ["maintenance_policy"],
                "clarificationQuestion": None,
                "reason": "需要查询保养政策",
            }

        if "准备材料" in question:
            return {
                "route": "retrieve",
                "requiredEvidence": ["review_rule", "material_requirement"],
                "clarificationQuestion": None,
                "reason": "需要同时查询审核规则和材料要求",
            }

        return {
            "route": "retrieve",
            "requiredEvidence": ["review_rule"],
            "clarificationQuestion": None,
            "reason": "需要查询退款审核规则",
        }

    def direct(self, question: str) -> str:
        return "麻烦您尽快处理这笔退款，谢谢。"

    def answer(self, payload: dict) -> dict:
        return {
            "answer": "根据当前有效资料生成的测试答案。",
            "sourceIds": [chunk["id"] for chunk in payload["evidence"]],
        }


class BadSourceServices(FakeServices):
    """模拟模型生成了不存在的引用来源。"""

    def answer(self, payload: dict) -> dict:
        return {
            "answer": "这是一条没有通过来源校验的答案。",
            "sourceIds": ["NOT-EXISTS"],
        }


class MissingCitationServices(FakeServices):
    """模拟模型漏掉了其中一类必要证据的引用。"""

    def answer(self, payload: dict) -> dict:
        return {
            "answer": "这是一条引用不完整的答案。",
            "sourceIds": [payload["evidence"][0]["id"]],
        }


def run_graph(scenario_name: str, services: object | None = None) -> dict:
    graph = create_agentic_rag_graph(
        services=services or FakeServices(),
        principal=principal,
        now=now,
        max_searches=3,
    )

    return graph.invoke(
        {
            "question": scenarios[scenario_name]["question"],
        }
    )


class AgenticRagWorkflowTest(unittest.TestCase):
    def test_direct_request_skips_retrieval(self):
        result = run_graph("direct")

        self.assertEqual(result["outcome"], "direct")
        self.assertEqual(result["searchAttempts"], 0)
        self.assertEqual(result["sourceIds"], [])
        self.assertIn("direct_answer：未查询知识库", result["trace"])

    def test_single_evidence_request_answers_with_review_rule(self):
        result = run_graph("single")

        self.assertEqual(result["outcome"], "answered")
        self.assertEqual(result["searchAttempts"], 1)
        self.assertEqual(result["sourceIds"], ["KB-REFUND-REVIEW-V3"])

    def test_multi_evidence_request_searches_until_complete(self):
        result = run_graph("multi")

        self.assertEqual(result["outcome"], "answered")
        self.assertEqual(result["searchAttempts"], 2)
        self.assertEqual(
            set(result["sourceIds"]),
            {"KB-REFUND-REVIEW-V3", "KB-REFUND-MATERIAL-V2"},
        )
        self.assertTrue(
            any("仍缺少 material_requirement" in item for item in result["trace"])
        )

    def test_clarify_request_asks_user_for_missing_condition(self):
        result = run_graph("clarify")

        self.assertEqual(result["outcome"], "clarify")
        self.assertEqual(result["searchAttempts"], 0)
        self.assertIn("退款的金额", result["finalAnswer"])

    def test_unknown_policy_refuses_with_rejected_outdated_evidence(self):
        result = run_graph("unknown")

        self.assertEqual(result["outcome"], "refused")
        self.assertEqual(result["searchAttempts"], 1)
        self.assertEqual(result["sourceIds"], [])
        self.assertEqual(
            result["rejectedEvidence"],
            [
                {
                    "id": "KB-MAINTENANCE-OLD",
                    "reason": "文档已经停用或被新版本替代",
                }
            ],
        )

    def test_answer_with_invalid_source_id_is_refused(self):
        result = run_graph("single", services=BadSourceServices())

        self.assertEqual(result["outcome"], "refused")
        self.assertEqual(result["sourceIds"], [])
        self.assertIn("来源校验失败", result["trace"][-1])

    def test_answer_missing_required_citation_is_refused(self):
        result = run_graph("multi", services=MissingCitationServices())

        self.assertEqual(result["outcome"], "refused")
        self.assertEqual(result["sourceIds"], [])
        self.assertIn("来源校验失败", result["trace"][-1])


if __name__ == "__main__":
    unittest.main()

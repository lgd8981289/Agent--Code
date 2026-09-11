from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from app import create_app
from storage import InMemoryStore


class ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.storage = InMemoryStore()
        self.client = TestClient(create_app(storage=self.storage))
        self.headers = {
            "x-demo-token": "demo-linxia",
        }

    def test_health_and_auth_guard(self):
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["service"], "ai-interview-coach")

        unauthorized = self.client.get("/api/profile")
        self.assertEqual(unauthorized.status_code, 401)

    def test_create_session_and_submit_answer(self):
        created = self.client.post(
            "/api/sessions",
            headers=self.headers,
            json={
                "kind": "new",
                "mode": "replay",
            },
        )

        self.assertEqual(created.status_code, 200)
        state = created.json()
        self.assertEqual(state["status"], "awaiting_answer")

        answered = self.client.post(
            f"/api/sessions/{state['sessionId']}/answers",
            headers=self.headers,
            json={
                "answer": "它们都是保存聊天记录的。",
            },
        )

        self.assertEqual(answered.status_code, 200)
        result = answered.json()
        self.assertEqual(result["status"], "turn_complete")
        self.assertEqual(result["lastEvaluation"]["verdict"], "incorrect")
        self.assertEqual(len(result["evidence"]), 2)


if __name__ == "__main__":
    unittest.main()

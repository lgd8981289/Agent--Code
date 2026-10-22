import json
import unittest
import httpx
from server.main import create_app
from .support import Harness


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = await Harness().start()
        self.addAsyncCleanup(self.h.close)
        self.api = create_app(config=self.h.config, db=self.h.db, mcp=self.h.mcp, knowledge=self.h.knowledge)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.api, raise_app_exceptions=False), base_url="http://127.0.0.1:4320")
        self.addAsyncCleanup(self.client.aclose)

    async def login(self, id="lin"):
        response = await self.client.post("/api/login", json={"accountId": id})
        self.assertEqual(response.status_code, 201, response.text)
        return response

    async def test_complete_http_and_sse_contract(self):
        response = await self.login()
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("Path=/api", response.headers["set-cookie"])
        c = (await self.client.post("/api/conversations", json={"mode": "replay"})).json()
        response = await self.client.post(f"/api/conversations/{c['id']}/messages/stream", json={"message": "A1024 外壳裂了想退款"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        self.assertEqual(events[0]["type"], "status")
        c = events[-1]["conversation"]
        self.assertEqual(c["messages"][-1]["status"], "accepted")
        image = (await self.client.post(f"/api/conversations/{c['id']}/sample")).json()
        response = await self.client.post(f"/api/materials/{image['id']}/confirm", json={"observation": image["observation"]})
        self.assertEqual(response.status_code, 201, response.text)
        response = await self.client.get(f"/api/materials/{image['id']}/content")
        self.assertEqual(response.content[:8], b"\x89PNG\r\n\x1a\n")
        c = (await self.client.get(f"/api/conversations/{c['id']}")).json()
        response = await self.client.post(f"/api/conversations/{c['id']}/submit", json=dict(orderId="A1024", draftVersion=c["draftVersion"], amountCents=350000, reason="到货外壳损坏", fault="timeout_after_commit"))
        self.assertEqual(response.status_code, 201, response.text)
        item = response.json()
        await self.login("reviewer")
        response = await self.client.post(f"/api/cases/{item['id']}/review", json={"version": 1, "decision": "approve", "note": "材料核对通过"})
        self.assertEqual(response.json()["status"], "unknown", response.text)
        response = await self.client.post(f"/api/cases/{item['id']}/retry")
        self.assertEqual(response.json()["status"], "completed", response.text)
        response = await self.client.get(f"/api/cases/{item['id']}/report")
        self.assertEqual(response.json()["application"]["refund"]["amountCents"], 350000)
        self.assertTrue(response.json()["traces"])
        response = await self.client.get("/api/cases", params={"query": "A1024", "pageSize": 1, "page": 99})
        self.assertEqual((response.json()["total"], response.json()["page"]), (1, 1))

    async def test_auth_origin_validation_and_cross_user(self):
        self.assertEqual((await self.client.get("/api/bootstrap")).status_code, 401)
        self.assertEqual((await self.client.post("/api/login", json={"accountId": "lin"}, headers={"Origin": "https://evil.invalid"})).status_code, 403)
        await self.login()
        self.assertEqual((await self.client.post("/api/conversations", json={"mode": "ai"})).status_code, 400)
        c = (await self.client.post("/api/conversations", json={"mode": "replay"})).json()
        self.assertEqual((await self.client.post(f"/api/conversations/{c['id']}/messages", json={"message": ""})).status_code, 400)
        self.assertEqual((await self.client.get("/api/cases?page=0")).status_code, 400)
        await self.login("chen")
        self.assertEqual((await self.client.get(f"/api/conversations/{c['id']}")).status_code, 403)
        self.assertEqual((await self.client.post("/api/evaluations", json={})).status_code, 403)

    async def test_upload_validation_and_request_limit(self):
        await self.login()
        c = (await self.client.post("/api/conversations", json={"mode": "replay"})).json()
        response = await self.client.post(f"/api/conversations/{c['id']}/materials", files={"file": ("a.txt", b"\xff\xfe", "text/plain")})
        self.assertEqual(response.status_code, 400, response.text)
        response = await self.client.post(f"/api/conversations/{c['id']}/messages", json={"message": "x" * 110000})
        self.assertEqual(response.status_code, 413)
        self.assertEqual((await self.client.get("/api/health")).headers["x-content-type-options"], "nosniff")

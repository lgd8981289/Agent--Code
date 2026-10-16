"""使用 ASGI 本地客户端验证 HTTP 合同，不监听真实端口或调用外部模型。"""

import asyncio
import tempfile
import unittest

import httpx

from server.main import create_app
from test_arena import run_input, sample


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="python-arena-http-")
        self.app = create_app(env={}, directory=self.temp.name, replay_delay=0)
        self.lifecycle = self.app.router.lifespan_context(self.app)
        await self.lifecycle.__aenter__()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://127.0.0.1:4318")

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.lifecycle.__aexit__(None, None, None)
        self.temp.cleanup()

    async def finished(self, batch_id):
        task = self.app.state.arena.tasks.get(batch_id)
        if task:
            await asyncio.wait_for(task, 5)

    async def test_meta_history_and_missing_report(self):
        response = await self.client.get("/api/meta")
        self.assertEqual(response.status_code, 200)
        meta = response.json()
        self.assertFalse(meta["configured"])
        self.assertEqual(len(meta["versions"]), 4)
        self.assertEqual(len(meta["datasets"][0]["cases"]), 13)
        self.assertEqual(len(meta["sampleGuides"]["aftersales-v1"]), 13)
        self.assertEqual((await self.client.get("/api/runs")).json(), [])
        missing = await self.client.get("/api/runs/missing")
        self.assertEqual(missing.status_code, 404)
        self.assertIn("message", missing.json())

    async def test_complete_http_create_poll_gate_review_export(self):
        response = await self.client.post("/api/runs", json=run_input())
        self.assertEqual(response.status_code, 201)
        batch_id = response.json()["id"]
        await self.finished(batch_id)
        report = (await self.client.get(f"/api/runs/{batch_id}")).json()
        self.assertEqual(report["status"], "completed")
        self.assertEqual(len(report["sourceHash"]), 64)
        self.assertEqual(len(report["results"]), 26)
        gate = await self.client.post(f"/api/runs/{batch_id}/gate")
        self.assertEqual(gate.status_code, 201)
        self.assertEqual(gate.json()["status"], "passed")
        candidate = next(item for item in report["results"] if item["versionId"] == "fixed")
        review = await self.client.post(f"/api/runs/{batch_id}/reviews/{candidate['id']}",
                                        json={"verdict": "disagree", "note": "需要进一步核对"})
        self.assertEqual(review.status_code, 201)
        self.assertEqual(len(review.json()), 1)
        self.assertEqual((await self.client.post(f"/api/runs/{batch_id}/gate")).json()["status"], "needs_review")
        history = (await self.client.get("/api/runs")).json()
        self.assertEqual(history[0]["completed"], 26)

    async def test_versions_and_dataset_endpoints(self):
        value = {"name": "副本", "model": "test", "prompt": "提示", "fault": "none", "parentId": "fixed"}
        version = await self.client.post("/api/versions", json=value)
        self.assertEqual(version.status_code, 201)
        version_id = version.json()["id"]
        self.assertEqual((await self.client.delete(f"/api/versions/{version_id}")).status_code, 200)
        self.assertEqual((await self.client.delete("/api/versions/fixed")).status_code, 400)
        self.assertEqual((await self.client.delete("/api/versions/missing")).status_code, 404)
        dataset = await self.client.post("/api/datasets", json={"name": "导入测试", "cases": [sample("amount")]})
        self.assertEqual(dataset.status_code, 201)
        self.assertFalse(dataset.json()["builtin"])
        response = await self.client.post("/api/runs", json=run_input(datasetId=dataset.json()["id"], caseIds=["amount"]))
        self.assertEqual(response.status_code, 400)

    async def test_http_mutex_and_cancel(self):
        self.app.state.arena.replay_delay = .05
        response = await self.client.post("/api/runs", json=run_input())
        batch_id = response.json()["id"]
        self.assertEqual((await self.client.post("/api/runs", json=run_input())).status_code, 409)
        cancelled = await self.client.post(f"/api/runs/{batch_id}/cancel")
        self.assertEqual(cancelled.status_code, 201)
        await self.finished(batch_id)
        report = (await self.client.get(f"/api/runs/{batch_id}")).json()
        self.assertEqual(report["status"], "cancelled")

    async def test_bad_json_unknown_fields_and_bool_concurrency_are_400(self):
        for content in (b"not-json", b"", b'{"concurrency":NaN}'):
            response = await self.client.post("/api/runs", content=content)
            self.assertEqual(response.status_code, 400)
        response = await self.client.post("/api/runs", content=httpx.Request("POST", "http://test", json=run_input()).content,
                                          headers={"Content-Type": "text/plain"})
        self.assertEqual(response.status_code, 400)
        for patch in ({"extra": True}, {"concurrency": True}, {"candidateId": "baseline"}):
            response = await self.client.post("/api/runs", json=run_input(**patch))
            self.assertEqual(response.status_code, 400)
            self.assertIn("message", response.json())

    async def test_host_header_is_required_and_loopback_only(self):
        for host in ("evil.example", "127.0.0.1.evil.example", "[::1]:4318", ""):
            response = await self.client.get("/api/meta", headers={"Host": host})
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["message"], "仅允许本机访问")
        for host in ("localhost:4318", "127.0.0.1:4318"):
            self.assertEqual((await self.client.get("/api/meta", headers={"Host": host})).status_code, 200)

    async def test_origin_exact_allowlist(self):
        for origin in ("https://localhost:5188", "http://evil.example:5188", "null", "http://localhost:51880"):
            response = await self.client.post("/api/versions", json={}, headers={"Origin": origin})
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["message"], "请求来源不允许")
        for origin in ("http://localhost:5188", "http://127.0.0.1:4318"):
            self.assertEqual((await self.client.get("/api/meta", headers={"Origin": origin})).status_code, 200)

    async def test_body_limit_counts_streamed_bytes_without_content_length(self):
        async def stream():
            for _ in range(3):
                yield b"x" * (1024 * 1024)
        response = await self.client.post("/api/datasets", content=stream())
        self.assertEqual(response.status_code, 413)
        self.assertEqual((await self.client.get("/api/meta")).status_code, 200)

    async def test_ai_without_key_and_unsafe_version_are_refused(self):
        for patch in ({}, {"candidateId": "unsafe"}):
            response = await self.client.post("/api/runs", json=run_input(mode="ai", **patch))
            self.assertEqual(response.status_code, 400)
        self.assertEqual((await self.client.get("/api/runs")).json(), [])

    async def test_alternate_web_port_is_supported_without_broadening_origins(self):
        other = create_app(env={"PORT": "4328", "ARENA_WEB_PORT": "5198"}, directory=self.temp.name)
        async with other.router.lifespan_context(other):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=other), base_url="http://127.0.0.1:4328") as client:
                self.assertEqual((await client.get("/api/meta", headers={"Origin": "http://localhost:5198"})).status_code, 200)
                self.assertEqual((await client.get("/api/meta", headers={"Origin": "http://localhost:5188"})).status_code, 403)


if __name__ == "__main__":
    unittest.main()

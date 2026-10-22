import asyncio
import unittest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from server.main import create_app
from .support import Harness


class VoiceGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_cookie_auth_origin_and_final_draft(self):
        h = await Harness().start()
        self.addAsyncCleanup(h.close)
        h.config.env.update(DASHSCOPE_API_KEY="offline-placeholder", DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1")
        api = create_app(config=h.config, db=h.db, mcp=h.mcp, knowledge=h.knowledge)
        class FakeRecognition:
            def __init__(self, emit, config):
                self.emit = emit
                self.done = asyncio.get_running_loop().create_future()
                asyncio.create_task(emit("asr.ready", {}))
            async def append(self, audio): pass
            async def finish(self):
                await self.emit("asr.final", {"text": "订单 A 一 零 二 四"})
                self.done.set_result(None)
            async def close(self):
                self.done.cancel()
                await asyncio.gather(self.done, return_exceptions=True)
        api.state.gateway.factory = FakeRecognition
        def browser():
            with TestClient(api, base_url="http://127.0.0.1:4320") as client:
                with self.assertRaises(WebSocketDisconnect) as caught:
                    with client.websocket_connect("ws://127.0.0.1:4320/api/voice", headers={"origin": "http://127.0.0.1:5190"}) as ws:
                        ws.receive_json()
                self.assertEqual(caught.exception.code, 4001)
                client.post("/api/login", json={"accountId": "lin"})
                with self.assertRaises(WebSocketDisconnect) as caught:
                    with client.websocket_connect("ws://127.0.0.1:4320/api/voice", headers={"origin": "https://evil.invalid"}) as ws:
                        ws.receive_json()
                self.assertEqual(caught.exception.code, 1008)
                with client.websocket_connect("ws://127.0.0.1:4320/api/voice", headers={"origin": "http://127.0.0.1:5190"}) as ws:
                    ws.send_json({"event": "listen", "data": {"turnId": "turn-1"}})
                    self.assertEqual(ws.receive_json()["event"], "asr.ready")
                    ws.send_json({"event": "finish", "data": {"turnId": "turn-1"}})
                    event = ws.receive_json()
                    self.assertEqual(event, {"event": "asr.final", "data": {"text": "订单 A1024", "turnId": "turn-1"}})
        await asyncio.to_thread(browser)
        self.assertEqual(await h.db.records("conversation"), [])

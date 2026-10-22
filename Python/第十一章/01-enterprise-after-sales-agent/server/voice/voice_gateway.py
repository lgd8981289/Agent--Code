"""识别连接复用 /api 的登录 Cookie；异步识别不阻塞接收音频事件。"""

import asyncio
import json
import re
from fastapi import WebSocketDisconnect
from .asr import Recognition, asr_config
from .normalize import normalize_order_ids


class VoiceGateway:
    def __init__(self, auth, config, recognition_factory=Recognition):
        self.auth, self.config, self.factory = auth, config, recognition_factory
        self.active = {}
        self.sockets = set()

    async def reset(self, socket):
        session = self.active.pop(socket, None)
        if session:
            await session["recognition"].close()
            await asyncio.gather(session["watch"], return_exceptions=True)

    async def handle(self, socket):
        if socket.headers.get("origin") not in self.config.origins:
            await socket.close(code=1008)
            return
        try:
            await self.auth.actor(socket)
        except Exception:
            await socket.accept()
            await socket.close(code=4001, reason="请先选择演示账号")
            return
        await socket.accept()
        self.sockets.add(socket)
        try:
            while True:
                raw = await socket.receive_text()
                if len(raw.encode()) > 256*1024:
                    await socket.close(code=1009)
                    return
                data = {}
                try:
                    event = json.loads(raw)
                    if not isinstance(event, dict) or not isinstance(event.get("data", {}), dict):
                        raise ValueError("语音事件格式错误")
                    data = event.get("data") or {}
                    turn_id = data.get("turnId", "")
                    if event.get("event") == "listen":
                        await self.reset(socket)
                        if not isinstance(turn_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", turn_id):
                            continue
                        async def emit(name, details, current=turn_id):
                            if name == "asr.final":
                                details = {**details, "text": normalize_order_ids(details.get("text", ""))}
                            await socket.send_json({"event": name, "data": {**details, "turnId": current}})
                        recognition = self.factory(emit, asr_config(self.config.env))
                        async def watch(rec=recognition, emit_event=emit):
                            try:
                                await rec.done
                            except asyncio.CancelledError:
                                pass
                            except Exception as error:
                                await emit_event("error", {"message": str(error) or "识别超时，请重新录音"})
                        self.active[socket] = {"turnId": turn_id, "recognition": recognition, "watch": asyncio.create_task(watch())}
                    else:
                        session = self.active.get(socket)
                        if not session or session["turnId"] != turn_id:
                            continue
                        if event.get("event") == "audio":
                            await session["recognition"].append(data.get("audio"))
                        elif event.get("event") == "finish":
                            await session["recognition"].finish()
                        elif event.get("event") == "cancel":
                            await self.reset(socket)
                except Exception as error:
                    await socket.send_json({"event": "error", "data": {"turnId": data.get("turnId", ""), "message": str(error)}})
                    await self.reset(socket)
        except WebSocketDisconnect:
            pass
        finally:
            await self.reset(socket)
            self.sockets.discard(socket)

    async def close(self):
        for socket in list(self.sockets):
            await self.reset(socket)
            await socket.close()

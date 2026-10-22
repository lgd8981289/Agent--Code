"""百炼实时 ASR 协议，单轮 45 秒、16kHz PCM，预览与最终句子分别保存。"""

import asyncio
import base64
import re
from urllib.parse import urlsplit
from websockets.asyncio.client import connect
from ..common import uid, dumps, require


def asr_config(env):
    key, raw = env.get("DASHSCOPE_API_KEY", "").strip(), env.get("DASHSCOPE_BASE_URL", "").strip()
    require(key and raw, "实时语音识别需要配置 DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL")
    base = urlsplit(raw)
    require(base.scheme == "https" and base.hostname and not base.username and not base.password and not base.port and base.path.rstrip("/") == "/compatible-mode/v1",
            "DASHSCOPE_BASE_URL 必须是 https 的 /compatible-mode/v1 兼容接口地址")
    return {"key": key, "url": f"wss://{base.netloc}/api-ws/v1/realtime?model=qwen3-asr-flash-realtime"}


class Recognition:
    def __init__(self, emit, config, connector=connect):
        self.emit, self.config, self.connector = emit, config, connector
        self.ready, self.ending, self.bytes, self.items = False, False, 0, {}
        self.socket = None
        self.done = asyncio.create_task(self.run())

    async def send(self, type, **body):
        await self.socket.send(dumps({"event_id": uid(), "type": type, **body}))

    def preview(self):
        return "".join(i["text"] for i in self.items.values())

    async def partial(self):
        if self.preview():
            await self.emit("asr.partial", {"text": self.preview()})

    async def run(self):
        async with asyncio.timeout(45):
            async with self.connector(self.config["url"], additional_headers={"Authorization": f"Bearer {self.config['key']}", "OpenAI-Beta": "realtime=v1"}, open_timeout=10, max_size=256*1024) as socket:
                self.socket = socket
                await self.send("session.update", session={"input_audio_format": "pcm", "sample_rate": 16000,
                    "input_audio_transcription": {"language": "zh"}, "turn_detection": {"type": "server_vad", "threshold": 0, "silence_duration_ms": 600}})
                async for raw in socket:
                    if await self.event(__import__("json").loads(raw)):
                        return
                raise ValueError("识别连接提前关闭，请重新录音")

    async def event(self, event):
        type = event.get("type")
        if type == "session.updated" and not self.ready:
            self.ready = True
            await self.emit("asr.ready", {})
        if type == "conversation.item.created" and event.get("item", {}).get("id"):
            self.items.setdefault(event["item"]["id"], {"text": "", "final": False})
        if type in ("conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.completed"):
            id = event.get("item_id")
            require(id, "识别结果缺少句子编号")
            if type.endswith("completed"):
                self.items[id] = {"text": str(event.get("transcript") or "").strip(), "final": True}
            elif not self.items.get(id, {}).get("final"):
                self.items[id] = {"text": (event.get("text") or "") + (event.get("stash") or ""), "final": False}
            await self.partial()
        require(type not in ("conversation.item.input_audio_transcription.failed", "error"), event.get("error", {}).get("message", "ASR 服务返回错误"))
        require(len(self.items) <= 100 and len(self.preview()) <= 2000, "识别内容过长，请缩短问题")
        if type == "session.finished":
            text = self.preview().strip()
            require(text and not any(i["text"] and not i["final"] for i in self.items.values()), "没有识别到内容，请靠近麦克风再说一次")
            await self.emit("asr.final", {"text": text})
            return True
        return False

    async def append(self, audio):
        require(self.ready and not self.ending and not self.done.done(), "当前识别会话不能接收音频")
        require(isinstance(audio, str) and len(audio) <= 24000 and re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", audio), "音频块格式错误")
        try:
            chunk = base64.b64decode(audio, validate=True)
        except ValueError as error:
            raise ValueError("音频块格式错误") from error
        self.bytes += len(chunk)
        require(len(chunk) % 2 == 0 and self.bytes <= 16000*2*31, "录音格式错误或超过 30 秒")
        require(self.socket.transport.get_write_buffer_size() <= 128000, "网络发送过慢，请重新录音")
        await self.send("input_audio_buffer.append", audio=audio)

    async def finish(self):
        if self.ending or self.done.done():
            return
        require(self.ready and self.bytes >= 3200, "录音过短，请至少说一句完整的问题")
        self.ending = True
        await self.send("session.finish")

    async def close(self):
        self.done.cancel()
        await asyncio.gather(self.done, return_exceptions=True)

"""把取消事件与总时限传入异步 HTTP，而不是只停止页面轮询。"""

import asyncio
from contextlib import suppress
import time


class Cancellation:
    def __init__(self):
        self.event = asyncio.Event()

    @property
    def aborted(self):
        return self.event.is_set()

    def abort(self):
        self.event.set()


class Signal:
    def __init__(self, cancel, seconds):
        self.cancel = cancel
        self.deadline = time.monotonic() + seconds

    def throw_if_aborted(self):
        if self.cancel.aborted:
            raise RuntimeError("评测已取消。")
        if time.monotonic() >= self.deadline:
            raise TimeoutError("达到单样本 180 秒执行时限。")

    async def run(self, action):
        self.throw_if_aborted()
        # action 是函数：先检查取消，再创建协程，避免未 await 协程泄漏。
        request = asyncio.create_task(action())
        cancelled = asyncio.create_task(self.cancel.event.wait())
        try:
            done, _ = await asyncio.wait(
                (request, cancelled), timeout=max(0, self.deadline - time.monotonic()),
                return_when=asyncio.FIRST_COMPLETED)
            self.throw_if_aborted()
            if request not in done:
                raise TimeoutError("达到单样本 180 秒执行时限。")
            return await request
        finally:
            # 取消任务会向 HTTPX 传播，关闭正在进行的网络请求，不留下后台付费调用。
            for task in (request, cancelled):
                if not task.done():
                    task.cancel()
            for task in (request, cancelled):
                with suppress(asyncio.CancelledError, Exception):
                    await task

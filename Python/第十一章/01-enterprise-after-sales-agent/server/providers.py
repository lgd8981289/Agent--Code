"""外部 HTTP 入口可注入替身；默认不重试付费请求，不追随下载重定向。"""

import httpx
from .common import AppError, require


class JsonHttp:
    async def json(self, url, body, key, timeout=60):
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.post(url, json=body, headers={"Authorization": f"Bearer {key}"})
            try:
                data = response.json()
            except ValueError as error:
                raise AppError(f"模型接口返回无效 JSON（HTTP {response.status_code}）", 502) from error
            if not response.is_success:
                code = (data.get("error") or {}).get("code") if isinstance(data, dict) else None
                raise AppError(f"模型请求失败：HTTP {response.status_code}" + (f" {code}" if code else ""), 502)
            return data

    async def download(self, url, limit=16*1024*1024):
        content = bytearray()
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            async with client.stream("GET", url) as response:
                require(response.is_success, "语音已合成，但音频下载失败，请重新朗读")
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    require(len(content) <= limit, "朗读音频过大，请缩短内容后重试")
        return bytes(content)

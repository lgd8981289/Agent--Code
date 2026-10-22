"""等待正确的售后 API，端口被其他服务占用时不误判成功。"""

import json
import time
from urllib.request import urlopen
from server.config import Config


def wait_for_api(timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{Config().port}/api/health", timeout=1) as response:
                data = json.load(response)
                if data.get("ok") and data.get("service") == "aftersales-agent":
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError("售后 API 未能就绪，请检查数据库与服务日志")


if __name__ == "__main__":
    wait_for_api()

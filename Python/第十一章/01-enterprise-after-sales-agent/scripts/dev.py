"""同时启动 Python API 与 Vue，退出或任一服务失败时清理两个子进程。"""

import os
import shutil
import subprocess
import sys
import time
from server.config import ROOT
from .wait_for_api import wait_for_api


def main():
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("Vue 前端需要 Node.js 22.20+ 与 npm")
    processes = []
    try:
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        processes.append(subprocess.Popen([sys.executable, "-m", "server.main"], cwd=ROOT, env=env))
        wait_for_api()
        processes.append(subprocess.Popen([npm, "run", "dev"], cwd=ROOT / "web", env=env))
        while all(p.poll() is None for p in processes):
            time.sleep(.2)
    except KeyboardInterrupt:
        pass
    finally:
        for p in reversed(processes):
            if p.poll() is None:
                p.terminate()
        for p in processes:
            try:
                p.wait(timeout=8)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()


if __name__ == "__main__":
    main()

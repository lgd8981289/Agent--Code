"""只做离线编译与测试，不启动数据库、查询模型或访问用户凭证。"""

import ast
import os
import subprocess
import sys
from server.config import ROOT


def main():
    for name in ("server", "shared", "mcp_server", "scripts", "tests"):
        for path in (ROOT / name).rglob("*.py"):
            ast.parse(path.read_text(), filename=str(path))
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false"}
    return subprocess.call([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"], cwd=ROOT, env=env)


if __name__ == "__main__":
    raise SystemExit(main())

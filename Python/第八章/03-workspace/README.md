# 03 - Workspace（Python）

本节用三个游戏设定文件演示 Workspace：保留全部资料，但只把当前问题需要的世界观和场景正文加入待发送文本。没有模型调用，也不需要 API Key。

`workspace_demo.py` 是运行入口；`workspace/game/` 是与 Node 版独立的示例文件。已有文件不会被启动脚本覆盖。

在本小节目录运行：

```bash
uv run python workspace_demo.py
```

预期显示：方案 A 为 **349 字符**，方案 B 为 **200 字符**，并指出场景中的通信情节违反世界规则。离线验证：

```bash
uv run python -m unittest discover -s tests
```

依赖由 `pyproject.toml` 和 `uv.lock` 锁定；需要 Python 3.11 或更新版本。

# 02 - Deep Agents 入门（Python）

本节让 Deep Agent 为一座失去通信的太空站设计三条互不冲突的世界规则，将初稿写入 `workspace/game/world.md`，读取文件确认落盘后再输出结果。

`deep_agent.py` 是完整入口；`workspace/game/world.md` 是课程示例产物。Agent 看到的 `/game/world.md` 对应本小节目录内的 `workspace/game/world.md`。

离线验证（不调用模型）：

```bash
uv run python -m unittest discover -s tests
```

运行真实模型前，先让当前进程取得你已有的 `DEEPSEEK_API_KEY`，可选设置 `DEEPSEEK_MODEL`（默认 `deepseek-v4-flash`），然后在本小节目录运行：

```bash
uv run python deep_agent.py
```

预期终端显示工具调用轨迹、最终回答和生成文件的绝对路径。依赖由 `pyproject.toml` 和 `uv.lock` 锁定，使用 Python 3.11 或更新版本。

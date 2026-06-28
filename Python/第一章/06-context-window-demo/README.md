# Context Window 与输入预算

这个小节包含两个独立示例：

- `context_budget.py`：离线演示如何为输出、外部资料和历史消息分配上下文预算。
- `observe_context.py`：调用 DeepSeek API，观察多轮对话中输入 Token 的增长。

## 运行预算裁剪实验

```bash
python3 context_budget.py
```

这个脚本不访问网络。预期输入预算为 `120`，完整历史需要 `202` Token，裁剪后使用 `107` Token，保留最近 `1` 轮并移出 `2` 轮旧历史。

## 观察真实 API Token 用量

```bash
cp .env.example .env
```

填写 `.env` 中的 `DEEPSEEK_API_KEY`，然后在当前小节目录执行：

```bash
set -a
source .env
set +a
python3 observe_context.py
```

Python 标准解释器不会自动读取 `.env`。代码只使用 Python 标准库，不需要安装第三方依赖。

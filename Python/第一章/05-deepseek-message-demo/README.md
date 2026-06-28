# DeepSeek 多轮对话

这个示例演示大模型如何通过 `messages` 保存多轮对话上下文。每次请求都会携带 system 消息、历史 user/assistant 消息和当前用户输入。

## 离线运行

没有配置 API Key 时，程序会使用固定演示回复，不访问网络：

```bash
python3 multi_turn.py
```

## 调用真实 DeepSeek API

复制环境变量模板：

```bash
cp .env.example .env
```

填写 `.env` 中的 `DEEPSEEK_API_KEY`，然后在 zsh/bash 中执行：

```bash
set -a
source .env
set +a
python3 multi_turn.py
```

`source .env` 必须在当前小节目录执行。Python 标准解释器不会自动读取 `.env` 文件。

代码只使用 Python 标准库，不需要安装第三方依赖。

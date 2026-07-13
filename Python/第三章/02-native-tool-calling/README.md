# 原生 Tool Calling Python 版

这个示例使用 DeepSeek Chat Completions 的原生 Tool Calling 能力，演示模型如何请求调用工具、应用程序如何执行真实工具，并把工具结果返回给模型继续生成最终答案。

## 代码结构

- `demo.py`：维护 messages 循环，处理模型返回的 `tool_calls`，追加 `role: tool` 消息。
- `deepseek_client.py`：封装 DeepSeek Chat Completions HTTP 请求。
- `tools.py`：定义工具 JSON Schema、本地订单数据、参数校验和真实工具执行逻辑。

代码只使用 Python 标准库，要求 Python 3.11 或更高版本，不需要安装第三方依赖。

## 离线验证

从当前小节目录执行：

```bash
python3 -m py_compile demo.py deepseek_client.py tools.py
```

工具逻辑可以在不调用模型的情况下直接测试，例如执行 `get_order` 或 `check_refund_eligibility` 的本地函数调用。

## 调用真实 DeepSeek API

Python 标准解释器不会自动读取 `.env`。如果你已经有自己的 `.env`，先在当前 shell 中加载：

```bash
set -a
source .env
set +a
python3 demo.py
```

程序需要 `DEEPSEEK_API_KEY`。可选环境变量包括：

- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com/chat/completions`
- `DEEPSEEK_MODEL`：默认 `deepseek-v4-flash`
- `MAX_TOOL_ROUNDS`：默认 `4`

默认问题是：

```text
查询订单 A1024 是否满足退款条件，并告诉我是否需要人工审核。
```


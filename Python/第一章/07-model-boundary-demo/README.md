# 模型能力边界与 Temperature

这个小节包含两个示例：

- `reliable_refund_agent.py`：业务代码负责查询订单和计算审核结论，大模型只负责把确定结果改写成自然语言。
- `temperature_demo.py`：分别使用 `0.1` 和 `1.5` 的 temperature 各生成三次欢迎语，观察输出差异。

两个脚本都需要调用真实 DeepSeek API。先在当前目录执行：

```bash
cp .env.example .env
```

填写 `DEEPSEEK_API_KEY` 后运行：

```bash
set -a
source .env
set +a

python3 reliable_refund_agent.py
python3 temperature_demo.py
```

Python 标准解释器不会自动读取 `.env`。代码只使用 Python 标准库，不需要安装第三方依赖。

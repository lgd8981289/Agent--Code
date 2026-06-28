# 模型路由器

这个示例先分析任务特征，再选择合适的执行路线：

- 普通文本改写：`normal_text`
- 确定性业务判断：`deterministic_code`
- 复杂规则分析：`reasoning_text`
- 图片任务规划：`vision_plan`

## 离线运行

```bash
python3 demo.py
```

没有配置 API Key 时，确定性规则会由代码直接执行，图片任务只输出执行计划，两个 DeepSeek 文本任务只打印请求体，不访问网络。

## 调用真实 DeepSeek API

```bash
cp .env.example .env
```

填写 `.env` 中的 `DEEPSEEK_API_KEY`，然后在当前小节目录执行：

```bash
set -a
source .env
set +a
python3 demo.py
```

代码只使用 Python 标准库，不需要安装第三方依赖。

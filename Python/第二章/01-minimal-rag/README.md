# 最小 RAG 演示

这个示例不依赖向量数据库，使用内存知识库和关键词匹配，演示 Retrieval、Augmentation、Generation 三个步骤。

## 离线运行

```bash
python3 mini_rag.py
```

没有配置 API Key 时，程序会使用固定演示回答，不访问网络。

## 调用真实 DeepSeek API

```bash
cp .env.example .env
set -a
source .env
set +a
python3 mini_rag.py
```

填写 `.env` 中的 `DEEPSEEK_API_KEY` 后再运行。`source .env` 必须在当前小节目录执行。

代码只使用 Python 标准库，不需要安装第三方依赖。

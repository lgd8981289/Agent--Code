# 内存向量检索

这个示例先为六份企业资料生成向量并构建内存索引，再把用户问题转换成向量，使用余弦相似度检索 TopK 文档。

## 运行

```bash
cp .env.example .env
set -a
source .env
set +a
python3 memory_vector_search.py
```

填写 `.env` 中的 `ZHIPU_API_KEY` 后再运行。程序默认返回相似度最高的三份资料，并把它们拼接成准备交给大模型的上下文。

代码只使用 Python 标准库，不需要安装第三方依赖。

# Embedding 语义检索

这个示例把用户问题和三份企业资料批量转换成向量，再使用余弦相似度找出语义最接近的资料。

## 运行

```bash
cp .env.example .env
set -a
source .env
set +a
python3 embedding_search.py
```

填写 `.env` 中的 `ZHIPU_API_KEY` 后再运行。程序默认使用 `embedding-3`，向量维度为 `512`。

代码只使用 Python 标准库，不需要安装第三方依赖。

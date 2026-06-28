# Transformer Attention 演示

这个示例使用手工编写的 Token 特征和 Attention Head 权重，演示一次简化的注意力计算：

1. 生成目标 Token 的 Query。
2. 生成可见 Token 的 Key 和 Value。
3. 计算缩放点积和 Softmax 权重。
4. 按注意力权重汇总 Value。

## 运行

```bash
python3 attention_demo.py
```

程序会输出“人工审核”对前文 Token 的注意力权重 Top 6，以及加权汇总后的新表示。

代码只使用 Python 标准库，不需要安装依赖，也不会访问网络。

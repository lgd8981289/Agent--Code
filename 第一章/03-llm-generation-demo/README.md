# 逐 Token 生成演示

这个示例用一组固定的候选 Token 和 Logit，模拟大模型逐步生成文本的过程。

Node.js 与 Python 版本保持相同的候选数据、Softmax 计算、贪心选择策略和结束条件。代码不会调用真实模型，也不需要安装第三方依赖。

## 目录

```text
03-llm-generation-demo/
├── node/
│   └── generation-loop.mjs    # Node.js 版本
└── python/
    └── generation_loop.py     # Python 版本
```

## 运行 Node.js 版本

在当前目录执行：

```bash
node node/generation-loop.mjs
```

## 运行 Python 版本

在当前目录执行：

```bash
python3 python/generation_loop.py
```

两个版本都会依次展示：

1. 当前上下文；
2. 候选 Token 及其概率；
3. 本轮通过贪心策略选中的 Token；
4. 遇到 `<EOS>` 后停止生成。

最终生成的内容应该是：

```text
周末我准备学习 Agent。
```

Python 版本使用 `dict` 表示候选映射，使用 `math.exp()` 计算 Softmax，并通过 `max(..., key=...)` 选择概率最高的 Token。这些写法符合 Python 的常用编码习惯，不是对 Node.js 代码的逐行语法翻译。

# 模拟大模型逐 Token 生成

这个示例使用固定候选数据，演示大模型生成文本时最核心的循环：

1. 根据当前上下文取得候选 Token 和 Logit。
2. 使用 Softmax 把 Logit 转换成概率。
3. 使用贪心策略选择概率最高的 Token。
4. 把 Token 拼接到上下文，继续生成。
5. 遇到 `<EOS>` 时停止。

代码只使用 Python 标准库，不需要安装依赖，也不会调用真实大模型 API。

## 运行

进入当前目录后执行：

```bash
python3 generation_loop.py
```

程序会输出每一步的候选 Token、概率和最终选择。预期最终结果为：

```text
最终内容：周末我准备学习 Agent。
```

## 与 Node.js 版本的对应关系

| Node.js | Python |
| --- | --- |
| `Map` | `dict` |
| `Math.exp()` | `math.exp()` |
| `Array.reduce()` | `sum()` / `max()` |
| `for` 生成循环 | `for` 生成循环 |

两个版本使用相同的候选数据、Softmax 算法、贪心策略和停止条件。

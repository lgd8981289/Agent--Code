# 基于证据回答与引用来源

这个示例演示 RAG 生成阶段的两个关键约束：正常回答必须绑定真实 Chunk 来源；知识库证据不足时必须拒答，不能让模型依靠自身知识猜测。

## 代码结构

- `01_answer_with_sources.py`：让模型返回答案和 `sourceChunkIds`，再由程序绑定系统保存的标题、文件路径和 Chunk 原文。
- `02_answer_with_refusal.py`：校验证据是否足以回答问题；资料不足时返回统一拒答内容，并保证来源为空。

代码只使用 Python 标准库，要求 Python 3.11 或更高版本，不需要安装第三方依赖。

## 运行带来源的回答

从当前小节目录执行：

```bash
set -a
source .env
set +a
python3 01_answer_with_sources.py
```

程序会输出最终答案，以及系统根据 Chunk ID 找到的来源标题、文件路径和原文。

## 运行证据不足拒答

```bash
set -a
source .env
set +a
python3 02_answer_with_refusal.py
```

程序需要 `ZHIPU_API_KEY`。`CHAT_MODEL` 可选，默认使用 `glm-4.7-flash`。

当前拒答案例中，用户询问咖啡机保修年限，但候选资料只包含退款到账时间，因此预期结果是 `insufficient_evidence`、统一拒答内容和空来源列表。

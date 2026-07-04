# RAG 评估：Recall@K、MRR 与 Faithfulness

这个示例使用三个固定案例评估 RAG 的检索和生成结果，并根据指标定位召回、排序或答案生成阶段的问题。

## 代码结构

- `evaluation_cases.py`：提供人工标注的相关 Chunk、当前检索结果和最终答案。
- `rag_evaluator.py`：计算 Recall@K、RR、MRR，并调用评估模型计算 Faithfulness。
- `run_evaluation.py`：运行全部案例，汇总指标并输出问题定位建议。

代码只使用 Python 标准库，要求 Python 3.11 或更高版本，不需要安装第三方依赖。

## 只评估检索指标

从当前小节目录执行：

```bash
python3 run_evaluation.py retrieval
```

这个模式完全离线，不调用大模型。程序会计算每个案例的 `Recall@3` 和 `RR@3`，最后输出整个评估集的 `Mean Recall@3` 与 `MRR@3`。

## 执行完整评估

完整模式会在检索指标之外，调用评估模型把答案拆成 Claim，并判断每个 Claim 是否能被检索上下文直接支持：

```bash
set -a
source .env
set +a
python3 run_evaluation.py full
```

程序需要 `ZHIPU_API_KEY`。`EVALUATOR_MODEL` 可选；未配置时依次使用 `CHAT_MODEL` 和默认模型 `glm-4.7-flash`。

Faithfulness 由程序根据模型返回的 Claim 判断计算：

```text
Faithfulness = 有上下文支持的 Claim 数量 / 全部 Claim 数量
```

评估模型只能判断每个 Claim 是否有证据，不能直接给出总分。程序还会校验 Claim 字段、支持关系和 Chunk ID，避免直接信任模型返回的数据。

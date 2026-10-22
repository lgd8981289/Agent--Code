import type { EvaluationReport } from "./types.js";
export function compareEvaluations(
  current: EvaluationReport,
  previous: EvaluationReport,
) {
  if (current.mode !== previous.mode)
    return { error: "Replay 与 AI 报告不能直接比较", rows: [] };
  if (
    !current.snapshot ||
    !previous.snapshot ||
    current.snapshot.datasetHash !== previous.snapshot.datasetHash
  )
    return {
      error: "数据集版本不同或缺少快照，请用同一组任务重新评测",
      rows: [],
    };
  const old = new Map(previous.items.map((i) => [i.id, i]));
  if (old.size !== current.items.length || current.items.some((i) => !old.has(i.id)))
    return { error: "样本集合不一致，不能计算变化", rows: [] };
  return {
    error: "",
    rows: current.items.map((item) => ({
      id: item.id,
      name: item.name,
      before: old.get(item.id)!.status,
      after: item.status,
      change:
        item.status === old.get(item.id)!.status
          ? "不变"
          : item.status === "passed"
            ? "改善"
            : old.get(item.id)!.status === "passed"
              ? "退步"
              : "异常类型变化",
    })),
  };
}

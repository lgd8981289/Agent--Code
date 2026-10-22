import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { policies } from "./knowledge/catalog.js";
import { MilvusPolicies, policyHash } from "./knowledge/milvus.js";
import type { Policy } from "../shared/types.js";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
export function tokens(text: string) {
  return [...segmenter.segment(text.toLowerCase())]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
}
/** 小型企业政策库采用真实 BM25 排序，范围与有效版本先过滤，不伪装为向量检索。 */
export function retrieve(
  query: string,
  tenantId: string,
  category?: Policy["category"],
) {
  const docs = policies.filter(
    (p) =>
      p.tenantId === tenantId && p.active && (!category || p.category === category),
  );
  const terms = [...new Set(tokens(query))],
    all = docs.map((d) => tokens(d.title + d.content));
  const average = all.reduce((n, a) => n + a.length, 0) / (all.length || 1);
  return docs
    .map((doc, i) => {
      let score = 0;
      for (const term of terms) {
        const frequency = all[i].filter((t) => t === term).length;
        const df = all.filter((a) => a.includes(term)).length;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        score +=
          (idf * frequency * 2.2) /
          (frequency + 1.2 * (0.25 + (0.75 * all[i].length) / (average || 1)));
      }
      return { ...doc, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
@Injectable()
export class Knowledge implements OnModuleDestroy {
  private hybrid?: MilvusPolicies;
  async onModuleDestroy() {
    await this.hybrid?.close();
  }
  revalidate(tenant: string, snapshots: Policy[]) {
    return snapshots.flatMap((snapshot) => {
      const current = policies.find(
        (p) => p.id === snapshot.id && p.tenantId === tenant && p.active,
      );
      return current && policyHash(current) === policyHash(snapshot) ? [current] : [];
    });
  }

  /** 检索指定租户的政策资料，根据运行模式和配置选择本地检索或 Milvus 混合检索。 */
  search(
    query: string,
    tenant: string,
    category?: Policy["category"],
    mode: "ai" | "replay" = "replay",
  ): Policy[] | Promise<Policy[]> {
    // 读取知识库后端配置，未配置时默认使用本地检索。
    const backend = process.env.KNOWLEDGE_BACKEND || "local";

    // Replay 模式始终使用本地检索；AI 模式下配置为 local 时也使用本地检索。
    // query 为检索内容，tenant 用于租户隔离，category 用于筛选政策类别。
    if (mode === "replay" || backend === "local")
      return retrieve(query, tenant, category);

    // 非本地检索时，仅允许使用 Milvus 后端。
    if (backend !== "milvus")
      throw new Error("KNOWLEDGE_BACKEND 仅支持 local 或 milvus");

    // 延迟初始化 Milvus 检索实例，避免每次检索都重新创建。
    this.hybrid ??= MilvusPolicies.connect();

    // 执行 Milvus 混合检索，返回当前租户下符合条件的政策资料。
    return this.hybrid.search(query, tenant, category, policies);
  }
}

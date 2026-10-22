import {
  MilvusClient,
  DataType,
  FunctionType,
  IndexType,
  MetricType,
  RRFRanker,
} from "@zilliz/milvus2-sdk-node";
import { createHash } from "node:crypto";
import type { Policy } from "../../shared/types.js";

export const policyHash = (p: Policy) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        id: p.id,
        tenantId: p.tenantId,
        title: p.title,
        version: p.version,
        active: p.active,
        category: p.category,
        content: p.content,
        source: p.source,
      }),
    )
    .digest("hex");
export function policyFilter(tenant: string, category?: Policy["category"]) {
  return `tenant_id == ${JSON.stringify(tenant)} and is_active == true${category ? ` and category == ${JSON.stringify(category)}` : ""}`;
}
export function ensureOk(value: unknown) {
  const result = value as {
    status?: { code?: number; error_code?: string; reason?: string };
    code?: number;
    error_code?: string;
    reason?: string;
  };
  const status = result.status ?? result;
  if (
    Number(status.code ?? 0) !== 0 ||
    (status.error_code && status.error_code !== "Success")
  )
    throw new Error(`Milvus 操作失败：${status.reason ?? status.error_code}`);
}
export interface RankingModels {
  embed(texts: string[]): Promise<number[][]>;
  rerank(query: string, docs: Policy[]): Promise<number[]>;
}
export class ZhipuRanking implements RankingModels {
  constructor(
    readonly dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 512),
  ) {
    if (![256, 512, 1024, 2048].includes(dimensions))
      throw new Error("EMBEDDING_DIMENSIONS 必须为 256/512/1024/2048");
  }
  private async post(path: string, body: object) {
    const key = process.env.ZHIPU_API_KEY;
    if (!key) throw new Error("Milvus 检索需要配置 ZHIPU_API_KEY");
    const base = (
      process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4"
    ).replace(/\/$/, "");
    const response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`${path} 请求失败：HTTP ${response.status}`);
    return response.json();
  }
  async embed(texts: string[]) {
    const output: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const body = (await this.post("embeddings", {
        model: process.env.EMBEDDING_MODEL || "embedding-3",
        input: batch,
        dimensions: this.dimensions,
      })) as { data?: { index: number; embedding: number[] }[] };
      const rows = body.data?.sort((a, b) => a.index - b.index);
      if (
        !rows ||
        rows.length !== batch.length ||
        rows.some(
          (r, j) =>
            r.index !== j ||
            r.embedding?.length !== this.dimensions ||
            r.embedding.some((n) => !Number.isFinite(n)),
        )
      )
        throw new Error("Embedding 返回数量、下标或向量维度不匹配");
      output.push(...rows.map((r) => r.embedding));
    }
    return output;
  }
  async rerank(query: string, docs: Policy[]) {
    const body = (await this.post("rerank", {
      model: process.env.RERANK_MODEL || "rerank",
      query,
      documents: docs.map((p) => `${p.title}\n${p.content}`),
      top_n: Math.min(3, docs.length),
      return_documents: false,
    })) as { results?: { index: number }[] };
    const indices = body.results?.map((r) => r.index);
    if (
      !indices ||
      !indices.length ||
      new Set(indices).size !== indices.length ||
      indices.some((i) => !Number.isInteger(i) || i < 0 || i >= docs.length)
    )
      throw new Error("Rerank 返回了无效文档下标");
    return indices.slice(0, 3);
  }
}

export class MilvusPolicies {
  constructor(
    readonly client: Pick<
      MilvusClient,
      | "hybridSearch"
      | "hasCollection"
      | "createCollection"
      | "loadCollection"
      | "upsert"
      | "flushSync"
      | "closeConnection"
    >,
    readonly ranking: RankingModels,
    readonly collection = process.env.AFTERSALES_POLICY_COLLECTION ||
      "aftersales_policies_v1",
    readonly dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 512),
  ) {}
  static connect() {
    return new MilvusPolicies(
      new MilvusClient({
        address: process.env.MILVUS_ADDRESS || "127.0.0.1:19530",
        token: process.env.MILVUS_TOKEN || undefined,
        timeout: 30000,
      }),
      new ZhipuRanking(),
    );
  }
  async index(catalog: Policy[]) {
    const exists = await this.client.hasCollection({
      collection_name: this.collection,
    });
    ensureOk(exists);
    if (!exists.value) {
      ensureOk(
        await this.client.createCollection({
          collection_name: this.collection,
          fields: [
            {
              name: "key",
              data_type: DataType.VarChar,
              is_primary_key: true,
              max_length: 256,
            },
            { name: "policy_id", data_type: DataType.VarChar, max_length: 128 },
            { name: "tenant_id", data_type: DataType.VarChar, max_length: 128 },
            { name: "category", data_type: DataType.VarChar, max_length: 32 },
            { name: "is_active", data_type: DataType.Bool },
            { name: "version", data_type: DataType.Int32 },
            { name: "checksum", data_type: DataType.VarChar, max_length: 64 },
            {
              name: "content",
              data_type: DataType.VarChar,
              max_length: 32768,
              enable_analyzer: true,
              analyzer_params: { tokenizer: "jieba", filter: ["removepunct"] },
            },
            {
              name: "dense_vector",
              data_type: DataType.FloatVector,
              dim: this.dimensions,
            },
            { name: "sparse_vector", data_type: DataType.SparseFloatVector },
          ],
          functions: [
            {
              name: "content_bm25",
              type: FunctionType.BM25,
              input_field_names: ["content"],
              output_field_names: ["sparse_vector"],
              params: {},
            },
          ],
          index_params: [
            {
              field_name: "dense_vector",
              index_type: IndexType.AUTOINDEX,
              metric_type: MetricType.COSINE,
            },
            {
              field_name: "sparse_vector",
              index_type: IndexType.SPARSE_INVERTED_INDEX,
              metric_type: MetricType.BM25,
            },
          ],
        }),
      );
    }
    const embeddings = await this.ranking.embed(
      catalog.map((p) => `${p.title}\n${p.content}`),
    );
    ensureOk(
      await this.client.upsert({
        collection_name: this.collection,
        data: catalog.map((p, i) => ({
          key: `${p.tenantId}:${p.id}`,
          policy_id: p.id,
          tenant_id: p.tenantId,
          category: p.category,
          version: p.version,
          is_active: p.active,
          checksum: policyHash(p),
          content: `${p.title}\n${p.content}`,
          dense_vector: embeddings[i],
        })),
      }),
    );
    ensureOk(
      await this.client.flushSync({ collection_names: [this.collection] }),
    );
    ensureOk(
      await this.client.loadCollection({ collection_name: this.collection }),
    );
  }
  async search(
    query: string,
    tenant: string,
    category: Policy["category"] | undefined,
    catalog: Policy[],
  ) {
    const filter = policyFilter(tenant, category);
    const [vector] = await this.ranking.embed([query]);
    const response = await this.client.hybridSearch({
      collection_name: this.collection,
      data: [
        { anns_field: "dense_vector", data: vector, limit: 12, expr: filter },
        { anns_field: "sparse_vector", data: query, limit: 12, expr: filter },
      ],
      rerank: RRFRanker(60),
      limit: 8,
      output_fields: [
        "policy_id",
        "tenant_id",
        "version",
        "category",
        "is_active",
        "checksum",
      ],
    });
    ensureOk(response);
    // 索引可能落后于目录。再核对内容摘要，旧资料绝不能成为新回答的依据。
    const candidates = (response.results as Record<string, unknown>[]).flatMap(
      (r) => {
        const p = catalog.find(
          (p) =>
            p.id === r.policy_id &&
            p.tenantId === tenant &&
            p.active &&
            (!category || p.category === category),
        );
        return p &&
          r.tenant_id === tenant &&
          r.is_active === true &&
          r.version === p.version &&
          r.checksum === policyHash(p)
          ? [p]
          : [];
      },
    );
    const unique = [...new Map(candidates.map((p) => [p.id, p])).values()];
    if (!unique.length) return [];
    const indices = await this.ranking.rerank(query, unique);
    return indices.map((i) => unique[i]);
  }
  async close() {
    await this.client.closeConnection();
  }
}

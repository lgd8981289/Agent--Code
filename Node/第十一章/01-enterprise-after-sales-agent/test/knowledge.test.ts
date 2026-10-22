import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MilvusPolicies,
  policyHash,
  policyFilter,
} from "../server/knowledge/milvus.js";
import { policies } from "../server/fixtures.js";

test("混合检索两路先过滤权限，过期索引不能进入 Rerank，精排下标对应原文", async () => {
  const p = policies[0],
    q = policies[1];
  let request: any,
    reranked: string[] = [];
  const row = (p: (typeof policies)[number]) => ({
    policy_id: p.id,
    tenant_id: p.tenantId,
    is_active: p.active,
    version: p.version,
    checksum: policyHash(p),
  });
  const client = {
    hybridSearch: async (input: any) => {
      request = input;
      return {
        results: [
          row(p),
          { ...row(q), checksum: "old" },
          { ...row(p), tenant_id: "other" },
          row(q),
        ],
      };
    },
  } as any;
  const adapter = new MilvusPolicies(client, {
    embed: async () => [[0.1, 0.2]],
    rerank: async (_query, docs) => {
      reranked = docs.map((d) => d.id);
      return [1, 0];
    },
  });
  const result = await adapter.search("损坏", "xinghe", undefined, policies);
  assert.deepEqual(
    request.data.map((r: any) => r.expr),
    [policyFilter("xinghe"), policyFilter("xinghe")],
  );
  assert.deepEqual(
    request.data.map((r: any) => r.anns_field),
    ["dense_vector", "sparse_vector"],
  );
  assert.deepEqual(reranked, [p.id, q.id]);
  assert.deepEqual(
    result.map((r) => r.id),
    [q.id, p.id],
  );
  assert.equal(result[0].content, q.content);
  await adapter.search("照片", "xinghe", "materials", policies);
  assert.ok(request.data.every((r: any) => r.expr.includes('category == "materials"')));
  assert.ok(policyFilter('x" or true').includes('x\\" or true'));
});
test("Milvus 不可用时明确失败，不静默替换成成功的本地检索", async () => {
  const adapter = new MilvusPolicies(
    {
      hybridSearch: async () => ({
        status: { code: 1, reason: "not loaded" },
        results: [],
      }),
    } as any,
    { embed: async () => [[1]], rerank: async () => [] },
  );
  await assert.rejects(
    () => adapter.search("退款", "xinghe", undefined, policies),
    /not loaded/,
  );
});

test("政策索引按原文顺序绑定向量、版本和内容摘要", async () => {
  const writes: any[] = [];
  const client = {
    hasCollection: async () => ({ value: false }),
    createCollection: async (input: any) => {
      writes.push(input);
      return {};
    },
    upsert: async (input: any) => {
      writes.push(input);
      return {};
    },
    flushSync: async () => ({}),
    loadCollection: async () => ({}),
  } as any;
  const adapter = new MilvusPolicies(
    client,
    {
      embed: async () => [
        [1, 0],
        [0, 1],
      ],
      rerank: async () => [],
    },
    "test_collection",
    2,
  );
  await adapter.index(policies.slice(0, 2));
  assert.equal(writes[0].functions[0].input_field_names[0], "content");
  assert.deepEqual(
    writes[1].data.map((row: any) => row.dense_vector),
    [
      [1, 0],
      [0, 1],
    ],
  );
  assert.equal(writes[1].data[0].checksum, policyHash(policies[0]));
  assert.equal(writes[1].data[0].version, policies[0].version);
});

test("Embedding 和 Rerank HTTP 契约检查下标、维度与超界输出", async () => {
  const { createServer } = await import("node:http");
  const { ZhipuRanking } = await import("../server/knowledge/milvus.js");
  const requests: any[] = [];
  let invalid = false;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url === "/embeddings"
          ? {
              data: [1, 0].map((index) => ({
                index,
                embedding: Array(256).fill(index),
              })),
            }
          : { results: [{ index: invalid ? 99 : 1 }, { index: 0 }] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const key = process.env.ZHIPU_API_KEY,
    base = process.env.ZHIPU_BASE_URL;
  process.env.ZHIPU_API_KEY = "local-test";
  process.env.ZHIPU_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const model = new ZhipuRanking(256);
    const vectors = await model.embed(["first", "second"]);
    assert.equal(vectors[0][0], 0);
    assert.equal(vectors[1][0], 1);
    assert.equal(requests[0].dimensions, 256);
    assert.deepEqual(await model.rerank("损坏", policies.slice(0, 2)), [1, 0]);
    assert.equal(
      requests[1].documents[0],
      `${policies[0].title}\n${policies[0].content}`,
    );
    invalid = true;
    await assert.rejects(
      () => model.rerank("损坏", policies.slice(0, 2)),
      /无效文档下标/,
    );
    await assert.rejects(() => model.embed(["only-one"]), /不匹配/);
  } finally {
    if (key === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = key;
    if (base === undefined) delete process.env.ZHIPU_BASE_URL;
    else process.env.ZHIPU_BASE_URL = base;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

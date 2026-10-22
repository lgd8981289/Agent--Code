import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProposal, acceptedHistory } from "../server/consultation-state.js";
import { AfterSalesAggregate } from "../server/case.aggregate.js";
import {
  summarizeInvestigation,
  validateInvestigationTool,
} from "../server/investigation.service.js";
import { Knowledge, retrieve } from "../server/knowledge.service.js";
import { policies, orders, accounts } from "../server/fixtures.js";
import { compareEvaluations } from "../shared/evaluation-comparison.js";
import type {
  Conversation,
  Material,
  AfterSalesCase,
  EvaluationReport,
} from "../shared/types.js";
const c = (): Conversation => ({
  id: "c",
  tenantId: "xinghe",
  userId: "lin",
  title: "",
  mode: "replay",
  messages: [],
  proposal: null,
  caseId: null,
  materialIds: [],
  createdAt: "",
  updatedAt: "",
});
const photo: Material = {
  id: "m",
  tenantId: "xinghe",
  userId: "lin",
  conversationId: "c",
  name: "photo",
  mime: "image/png",
  kind: "image",
  bytes: 1,
  observation: "裂痕",
  confirmed: true,
  mode: "replay",
  at: "",
  orderId: "A1024",
};
const active = policies.filter((p) => p.active);
test("移除照片与跨订单照片不能填补申请材料，切换订单不会继承旧原因", () => {
  const conv = c();
  conv.proposal = buildProposal(conv, orders[0], "咖啡机外壳裂了", active, [photo]);
  assert.ok(!conv.proposal.missing.some((m) => m.includes("照片")));
  assert.ok(
    buildProposal(conv, orders[0], "", active, [
      { ...photo, removedAt: "now" },
    ]).missing.some((m) => m.includes("照片")),
  );
  const other = orders.find((o) => o.id === "A1026")!;
  const result = buildProposal(conv, other, "再看看 A1026", active, [photo]);
  assert.equal(result.reason, "");
  assert.ok(result.missing.some((m) => m.includes("照片")));
  assert.equal(
    buildProposal(conv, other, "", active, [photo], "开机漏水").reason,
    "开机漏水",
  );
});
test("只有验收成功的问答对能进入下一轮历史", () => {
  const conv = c();
  conv.messages = [
    { id: "1", role: "user", content: "正常问", at: "" },
    {
      id: "2",
      role: "assistant",
      content: "正常答",
      at: "",
      status: "accepted",
    },
    { id: "3", role: "user", content: "失败问", at: "" },
    {
      id: "4",
      role: "assistant",
      content: "本轮处理未完成：无效引用",
      at: "",
      status: "error",
    },
    { id: "5", role: "user", content: "当前问", at: "" },
  ];
  assert.deepEqual(acceptedHistory(conv), [
    { role: "user", content: "正常问" },
    { role: "assistant", content: "正常答" },
  ]);
});
test("历史政策重新核对正文与有效性，排序分数不影响身份", () => {
  const k = new Knowledge(),
    found = retrieve("到货损坏", "xinghe", "eligibility");
  assert.equal(k.revalidate("xinghe", found).length, found.length);
  assert.equal(k.revalidate("xinghe", [{ ...active[0], content: "被修改" }]).length, 0);
  assert.equal(k.revalidate("other", active).length, 0);
  assert.equal(k.revalidate("xinghe", [policies.find((p) => !p.active)!]).length, 0);
});
test("申请与材料修改使调查失效，旧版审批与旧报告不能重用", () => {
  const item = {
    id: "case",
    tenantId: "xinghe",
    userId: "lin",
    status: "waiting_review",
    version: 1,
    materialIds: ["m"],
    reviews: [],
    investigation: { id: "i", caseVersion: 1, status: "completed" },
  } as unknown as AfterSalesCase;
  const aggregate = new AfterSalesAggregate(item);
  aggregate.revise(accounts[0], 1, orders[0], 300000, "新说明", ["m"]);
  assert.equal(item.investigation?.status, "stale");
  assert.equal(item.investigation?.caseVersion, 1);
  assert.throws(
    () =>
      aggregate.review(accounts[2], {
        version: 1,
        decision: "approve",
        note: "",
      }),
    /版本/,
  );
  assert.throws(
    () =>
      aggregate.attachInvestigation({
        ...item.investigation!,
        status: "completed",
      }),
    /旧版本/,
  );
  aggregate.changeMaterial(accounts[0], 2, "m", true);
  assert.equal(item.version, 3);
  assert.equal(item.status, "needs_materials");
});
test("调查摘要来自已验收发现，不固定宣称存在冲突", () => {
  const summary = summarizeInvestigation(
    [{ file: "x", quote: "a", finding: "包装完整" }],
    [],
    [],
  );
  assert.match(summary, /包装完整/);
  assert.doesNotMatch(summary, /存在冲突/);
  assert.match(summarizeInvestigation([], [], []), /未.*|没有/);
});
test("评测对比拒绝混用执行模式或不同数据集", () => {
  const a = {
    mode: "replay",
    snapshot: { datasetHash: "same" },
    items: [{ id: "a", name: "金额", status: "passed" }],
  } as EvaluationReport;
  const b = { ...a, items: [{ ...a.items[0], status: "failed" as const }] };
  assert.equal(compareEvaluations(a, b).rows[0].change, "改善");
  assert.match(compareEvaluations(a, { ...b, mode: "ai" }).error, /不能/);
  assert.match(compareEvaluations(a, { ...b, snapshot: undefined }).error, /数据集/);
});

test("调查工具限制到本次输入与固定路径，动态 glob 不进入文件后端", () => {
  assert.equal(
    validateInvestigationTool(
      "read_file",
      { file_path: "/inputs/a.txt" },
      "fact-checker",
      ["/inputs/a.txt"],
    ),
    "/inputs/a.txt",
  );
  assert.throws(() =>
    validateInvestigationTool(
      "glob",
      { pattern: "{".repeat(2000) },
      "fact-checker",
      [],
    ),
  );
  assert.throws(() =>
    validateInvestigationTool(
      "read_file",
      { file_path: "/inputs/../secret" },
      "fact-checker",
      [],
    ),
  );
  assert.throws(() =>
    validateInvestigationTool("ls", { path: "/inputs/{a,b}" }, "fact-checker", []),
  );
  assert.throws(() =>
    validateInvestigationTool(
      "write_file",
      { file_path: "/staging/policy-checker.json" },
      "fact-checker",
      [],
    ),
  );
});

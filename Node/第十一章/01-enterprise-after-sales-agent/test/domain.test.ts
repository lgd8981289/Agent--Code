import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAmount,
  assertExecutable,
  assertOwner,
  assertVersion,
  canEdit,
  requestKey,
} from "../server/domain.js";
import { orders, accounts } from "../server/fixtures.js";
import { retrieve } from "../server/knowledge.service.js";
import { validateFindings } from "../server/investigation.service.js";
import type { AfterSalesCase } from "../shared/types.js";

const item = (): AfterSalesCase => ({
  id: "c",
  number: "AS-C",
  tenantId: "xinghe",
  userId: "lin",
  conversationId: "s",
  orderId: "A1024",
  product: "咖啡机",
  paidCents: 350000,
  amountCents: 350000,
  version: 1,
  status: "waiting_review",
  reason: "到货损坏",
  materialIds: [],
  sourceIds: [],
  reviews: [],
  refund: null,
  lastError: null,
  attempts: 0,
  fault: "none",
  faultConsumed: false,
  investigation: null,
  createdAt: "",
  updatedAt: "",
});
test("订单权限同时检查租户与用户", () => {
  assert.doesNotThrow(() => assertOwner(accounts[0], orders[0]));
  assert.throws(() => assertOwner(accounts[1], orders[0]));
  assert.throws(() => assertOwner(accounts[3], orders[0]));
  assert.throws(() => assertOwner(accounts[2], orders[0]));
});
test("金额采用整数分，超额、负数和非整数不能执行", () => {
  assert.doesNotThrow(() => assertAmount(350000, orders[0]));
  for (const n of [0, -1, 350001, 0.1, NaN])
    assert.throws(() => assertAmount(n, orders[0]));
});
test("客户输入与旧版批准不能代替当前审批", () => {
  const c = item();
  assert.throws(() => assertExecutable(c, orders[0]));
  c.status = "approved";
  c.reviews.push({
    id: "r",
    decision: "approve",
    note: "",
    reviewerId: "reviewer",
    version: 1,
    at: "",
  });
  assert.doesNotThrow(() => assertExecutable(c, orders[0]));
  c.version = 2;
  assert.throws(() => assertExecutable(c, orders[0]));
  assert.throws(() => assertVersion(c, 1));
});
test("同一申请版本使用稳定的业务请求编号", () => {
  const c = item();
  assert.equal(requestKey(c), requestKey(Object.assign({}, c, { attempts: 4 })));
  assert.notEqual(requestKey(c), requestKey({ ...c, version: 2 }));
});
test("已受理回执可核对，订单已扣减也不会重复退款", () => {
  const c = item();
  c.status = "unknown";
  c.reviews.push({
    id: "r",
    decision: "approve",
    note: "",
    reviewerId: "reviewer",
    version: 1,
    at: "",
  });
  const receipt = {
    id: "RF",
    requestKey: requestKey(c),
    caseId: c.id,
    version: 1,
    orderId: c.orderId,
    amountCents: 350000,
    status: "completed" as const,
    at: "",
  };
  assert.doesNotThrow(() =>
    assertExecutable(c, { ...orders[0], refundedCents: 350000 }, receipt),
  );
  assert.throws(() => assertExecutable(c, orders[0], { ...receipt, amountCents: 1 }));
});
test("进入执行后禁止修改申请", () => {
  const c = item();
  assert.doesNotThrow(() => canEdit(c));
  c.status = "executing";
  assert.throws(() => canEdit(c));
});
test("政策检索排除过期版本与其他企业", () => {
  const result = retrieve("咖啡机到货损坏退款", "xinghe");
  assert.ok(result.length > 0);
  assert.ok(result.every((p) => p.active));
  assert.equal(retrieve("退款", "other-company").length, 0);
  assert.ok(
    retrieve("损坏照片材料", "xinghe", "materials").every(
      (p) => p.category === "materials",
    ),
  );
});
test("调查结果必须逐字引用真实输入", () => {
  const inputs = { "/inputs/a.txt": "客服只承诺提交审核。" };
  assert.doesNotThrow(() =>
    validateFindings(
      {
        findings: [{ file: "/inputs/a.txt", quote: "提交审核", finding: "仍需审批" }],
        unresolved: [],
      },
      inputs,
    ),
  );
  assert.throws(() =>
    validateFindings(
      {
        findings: [{ file: "/inputs/a.txt", quote: "已批准退款", finding: "批准" }],
        unresolved: [],
      },
      inputs,
    ),
  );
});

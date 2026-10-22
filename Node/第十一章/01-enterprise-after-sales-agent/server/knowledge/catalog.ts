import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { root } from "../config.js";

const policySchema = z.object({
  id: z.string().regex(/^POL-[A-Z0-9-]+$/),
  tenantId: z.string().min(1),
  title: z.string().min(1),
  version: z.number().int().positive(),
  active: z.boolean(),
  category: z.enum(["eligibility", "materials", "approval"]),
  content: z.string().min(1).max(8000),
  source: z.string().min(1),
});
// 发布时一起更新目录和索引；运行进程固定一个目录版本，重启后切换。
export const policies = z
  .array(policySchema)
  .parse(
    JSON.parse(readFileSync(join(root, "knowledge/policies.json"), "utf8")),
  );
if (
  new Set(policies.map((p) => `${p.tenantId}:${p.id}`)).size !== policies.length
)
  throw new Error("政策目录存在重复的租户/资料 ID");

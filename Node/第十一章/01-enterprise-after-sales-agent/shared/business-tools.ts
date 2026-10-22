import { z } from "zod";

const cents = z.number().int().nonnegative();
const order = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  product: z.string(),
  paidCents: cents,
  refundedCents: cents,
  signedAt: z.iso.datetime(),
  tracking: z.string(),
  deliveryStatus: z.string(),
});
const refund = z.object({
  id: z.string().min(1),
  requestKey: z.string().min(1),
  caseId: z.string().uuid(),
  version: z.number().int().positive(),
  orderId: z.string().min(1),
  amountCents: cents,
  status: z.literal("completed"),
  at: z.iso.datetime(),
});
/** MCP 返回值也是外部输入；TypeScript 泛型不能代替运行时校验。 */
export const toolOutputs = {
  list_orders: z.array(order),
  get_order: order,
  get_logistics: z.object({
    orderId: z.string().min(1),
    signedAt: z.iso.datetime(),
    tracking: z.string(),
    status: z.string(),
  }),
  submit_refund: refund,
  get_refund: refund.nullable(),
};
export type BusinessTool = keyof typeof toolOutputs;
export type ToolOutput<N extends BusinessTool> = z.infer<(typeof toolOutputs)[N]>;
export function parseToolOutput<N extends BusinessTool>(
  name: N,
  value: unknown,
): ToolOutput<N> {
  const result = toolOutputs[name].safeParse(value);
  if (!result.success)
    throw new Error(
      `业务工具 ${name} 返回的数据不符合约定：${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data as ToolOutput<N>;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { accounts } from "../server/fixtures.js";
import { Business } from "../server/business.js";
import { Storage } from "../server/storage.js";

const actor = accounts.find((a) => a.id === process.env.MCP_ACTOR_ID);
if (!actor || actor.role !== "customer")
  throw new Error("MCP 缺少由宿主设置的客户身份");
const db = new Storage();
const business = new Business(db);
const server = new McpServer({ name: "aftersales-business", version: "1.0.0" });
const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const run = (fn: () => Promise<unknown>) => async () => {
  try {
    return result(await fn());
  } catch (e) {
    return { ...result({ error: (e as Error).message }), isError: true };
  }
};
server.registerTool(
  "list_orders",
  { description: "查询当前客户自己的订单", inputSchema: {} },
  run(() => business.orders(actor)),
);

server.registerTool(
  "get_order",
  {
    description: "根据订单号核对本人订单",
    inputSchema: { orderId: z.string().max(30) },
  },
  async ({ orderId }) => run(() => business.order(actor, orderId))(),
);

server.registerTool(
  "get_logistics",
  {
    description: "查询本人订单签收和物流信息",
    inputSchema: { orderId: z.string().max(30) },
  },
  async ({ orderId }) =>
    run(async () => {
      const o = await business.order(actor, orderId);
      return {
        orderId: o.id,
        signedAt: o.signedAt,
        tracking: o.tracking,
        status: o.deliveryStatus,
      };
    })(),
);
server.registerTool(
  "submit_refund",
  {
    description: "执行已批准的申请；金额只从审批记录读取",
    inputSchema: { caseId: z.string().uuid() },
  },
  async ({ caseId }) => run(() => business.refund(actor, caseId))(),
);

server.registerTool(
  "get_refund",
  {
    description: "核对同一退款请求的实际执行结果",
    inputSchema: { caseId: z.string().uuid() },
  },
  async ({ caseId }) => run(() => business.lookup(actor, caseId))(),
);
await server.connect(new StdioServerTransport());
process.once("SIGTERM", () => void db.onModuleDestroy().finally(() => process.exit(0)));
process.stdin.once(
  "end",
  () => void db.onModuleDestroy().finally(() => process.exit(0)),
);

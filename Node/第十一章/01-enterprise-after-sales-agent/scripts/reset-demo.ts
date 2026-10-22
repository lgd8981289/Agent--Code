import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Storage } from "../server/storage.js";
import { port, root } from "../server/config.js";

if (!process.argv.includes("--yes")) {
  console.error(
    "此操作会删除本项目的会话、申请、退款、偏好、材料与评测记录。请先停止开发服务，再明确执行 npm run reset-demo -- --yes。",
  );
  process.exit(1);
}
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(1500),
  });
  if (response.ok) throw new Error("请先停止本项目的开发服务，再重置演示。");
} catch (e) {
  if ((e as Error).message.startsWith("请先停止")) throw e;
}
const db = new Storage();
try {
  const result = await db.pool.query("SELECT current_database() AS name");
  if (result.rows[0].name !== "aftersales_agent")
    throw new Error("重置脚本仅允许操作本项目默认的 aftersales_agent 数据库");
  const tables = await db.pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'",
  );
  const allowed = [
    "af_records",
    "af_refunds",
    "af_sessions",
    "checkpoints",
    "checkpoint_writes",
    "checkpoint_blobs",
    "store",
  ];
  const selected = allowed.filter((table) =>
    tables.rows.some((row) => row.tablename === table),
  );
  if (selected.length)
    await db.pool.query(
      `TRUNCATE ${selected.map((table) => `"${table}"`).join(",")} CASCADE`,
    );
  await rm(join(root, "data/materials"), { recursive: true, force: true });
  await rm(join(root, "workspaces"), { recursive: true, force: true });
  await db.setup();
  console.log(
    "演示数据已重置，订单签收时间与剩余可退金额已重新准备。可以再次运行 npm run dev。",
  );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.onModuleDestroy();
}

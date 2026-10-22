import { Storage } from "../server/storage.js";
const db = new Storage();
try {
  await db.setup();
  console.log(
    "PostgreSQL 业务表、LangGraph Checkpoint 与长期记忆已初始化。演示订单已准备，已有申请不会被覆盖。",
  );
} catch (e) {
  console.error("初始化失败：", (e as Error).message);
  process.exitCode = 1;
} finally {
  await db.onModuleDestroy();
}

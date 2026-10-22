import "reflect-metadata";
import { createApplication } from "../../server/application.factory.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Storage } from "../../server/storage.js";
import { McpBridge } from "../../server/mcp.js";
import { Knowledge } from "../../server/knowledge.service.js";
import { databaseUrl, root } from "../../server/config.js";
export async function isolatedSystem() {
  const admin = new Storage(),
    name = "af_consistency_" + randomUUID().replaceAll("-", ""),
    url = new URL(databaseUrl);
  url.pathname = "/" + name;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const db = new Storage(url.href),
    knowledge = new Knowledge(),
    mcp = new McpBridge({ POSTGRES_URI: url.href });
  try {
    await db.setup();
    const { app, agent, workflow: flow } = createApplication(db, mcp, knowledge);
    await flow.onModuleInit();
    return {
      db,
      app,
      agent,
      mcp,
      async close() {
        const files = await db.pool.query(
          "SELECT kind,id FROM af_records WHERE kind IN ('material','case')",
        );
        await knowledge.onModuleDestroy();
        await mcp.onModuleDestroy();
        await db.onModuleDestroy();
        await admin.pool.query(`DROP DATABASE "${name}"`);
        await admin.onModuleDestroy();
        for (const f of files.rows)
          await rm(
            join(root, f.kind === "material" ? "data/materials" : "workspaces", f.id),
            { force: true, recursive: true },
          );
      },
    };
  } catch (error) {
    await mcp.onModuleDestroy();
    await db.onModuleDestroy();
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.onModuleDestroy();
    throw error;
  }
}

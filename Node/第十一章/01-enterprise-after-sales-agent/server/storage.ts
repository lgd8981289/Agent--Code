import {
  ConflictException,
  Inject,
  Injectable,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { databaseUrl } from "./config.js";
import { orders } from "./fixtures.js";

@Injectable()
export class Storage implements OnModuleDestroy {
  readonly pool: Pool;
  readonly saver: PostgresSaver;
  readonly memories: PostgresStore;
  constructor(@Optional() @Inject("DATABASE_URL") url = databaseUrl) {
    this.pool = new Pool({ connectionString: url, max: 12 });
    this.pool.on("error", (error) =>
      console.error("业务数据库空闲连接异常：", error.message),
    );
    this.saver = PostgresSaver.fromConnString(url);
    this.memories = PostgresStore.fromConnString(url, { ensureTables: false });
  }

  async setup() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS af_records (
        kind text NOT NULL, id text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL,
        data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,id)
      );
      CREATE INDEX IF NOT EXISTS af_records_owner ON af_records(kind,tenant_id,user_id);
      CREATE TABLE IF NOT EXISTS af_refunds (
        request_key text PRIMARY KEY, case_id text NOT NULL UNIQUE, data jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS af_sessions (
        token_hash text PRIMARY KEY, actor_id text NOT NULL, expires_at timestamptz NOT NULL
      );
    `);
    for (const order of orders)
      await this.pool.query(
        `INSERT INTO af_records(kind,id,tenant_id,user_id,data) VALUES('order',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [order.id, order.tenantId, order.userId, JSON.stringify(order)],
      );
    await this.saver.setup();
    await this.memories.setup();
  }

  async get<T>(
    kind: string,
    id: string,
    client: PoolClient | Pool = this.pool,
    lock = false,
  ): Promise<T | null> {
    const result = await client.query(
      `SELECT data FROM af_records WHERE kind=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [kind, id],
    );
    return result.rows[0]?.data ?? null;
  }
  async put<T extends { id: string; tenantId: string; userId: string }>(
    kind: string,
    item: T,
    client: PoolClient | Pool = this.pool,
  ) {
    await client.query(
      `INSERT INTO af_records(kind,id,tenant_id,user_id,data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [kind, item.id, item.tenantId, item.userId, JSON.stringify(item)],
    );
    return item;
  }
  async list<T>(kind: string, tenantId: string, userId?: string): Promise<T[]> {
    const result = await this.pool.query(
      `SELECT data FROM af_records WHERE kind=$1 AND tenant_id=$2
      ${userId ? "AND user_id=$3" : ""} ORDER BY updated_at DESC LIMIT 200`,
      userId ? [kind, tenantId, userId] : [kind, tenantId],
    );
    return result.rows.map((row) => row.data);
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  // 跨进程按业务对象串行化。不能用进程内 Map 代替数据库执行锁。
  async locked<T>(key: string, fn: () => Promise<T>) {
    const deadline = Date.now() + 15000;
    let client: PoolClient | undefined;
    // 等锁时归还连接，避免等待者耗尽连接池，正在执行的任务仍可访问数据库。
    while (!client) {
      const candidate = await this.pool.connect();
      try {
        const result = await candidate.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [key],
        );
        if (result.rows[0].acquired) client = candidate;
        else candidate.release();
      } catch (e) {
        candidate.release();
        throw e;
      }
      if (!client) {
        if (Date.now() >= deadline)
          throw new ConflictException("这项操作正在处理中，请稍后刷新结果");
        await delay(50);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      } finally {
        client.release();
      }
    }
  }
  async onModuleDestroy() {
    const results = await Promise.allSettled([
      this.pool.end(),
      this.saver.end(),
      this.memories.stop(),
    ]);
    for (const result of results)
      if (result.status === "rejected")
        console.error("关闭数据库连接失败：", result.reason?.message);
  }
}

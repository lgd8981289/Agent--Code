"""PostgreSQL 业务记录、检查点与长期记忆。连接和迁移只在显式启动时执行。"""

import asyncio
from contextlib import asynccontextmanager
from time import monotonic

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres.aio import AsyncPostgresStore
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .common import AppError
from .config import Config
from .fixtures import seed_orders


class Storage:
    def __init__(self, url=None):
        self.url = url or Config().database_url
        self.pool = AsyncConnectionPool(self.url, min_size=1, max_size=12, open=False,
                                        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row})
        self.saver = AsyncPostgresSaver(self.pool)
        self.memories = AsyncPostgresStore(self.pool)

    async def open(self):
        try:
            await self.pool.open(wait=True, timeout=5)
        except BaseException:
            await self.pool.close()
            raise
        return self

    async def query(self, sql, params=(), client=None):
        async def run(conn):
            # 无参数的批量 DDL 必须走 simple query，空 tuple 会启用参数协议。
            cursor = await conn.execute(sql, params or None)
            return await cursor.fetchall() if cursor.description else []
        if client is not None:
            return await run(client)
        async with self.pool.connection() as conn:
            return await run(conn)

    async def setup(self):
        await self.query("""CREATE TABLE IF NOT EXISTS af_records (
          kind text NOT NULL,id text NOT NULL,tenant_id text NOT NULL,user_id text NOT NULL,
          data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,id));
          CREATE INDEX IF NOT EXISTS af_records_owner ON af_records(kind,tenant_id,user_id);
          CREATE TABLE IF NOT EXISTS af_refunds (request_key text PRIMARY KEY,case_id text NOT NULL UNIQUE,data jsonb NOT NULL);
          CREATE TABLE IF NOT EXISTS af_sessions (token_hash text PRIMARY KEY,actor_id text NOT NULL,expires_at timestamptz NOT NULL);""")
        for order in seed_orders():
            await self.query("INSERT INTO af_records(kind,id,tenant_id,user_id,data) VALUES('order',%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                             (order["id"], order["tenantId"], order["userId"], Jsonb(order)))
        await self.saver.setup()
        await self.memories.setup()

    async def get(self, kind, id, client=None, lock=False):
        rows = await self.query("SELECT data FROM af_records WHERE kind=%s AND id=%s" + (" FOR UPDATE" if lock else ""), (kind, id), client)
        return rows[0]["data"] if rows else None

    async def put(self, kind, item, client=None):
        await self.query("""INSERT INTO af_records(kind,id,tenant_id,user_id,data) VALUES(%s,%s,%s,%s,%s)
          ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()""",
                         (kind, item["id"], item["tenantId"], item["userId"], Jsonb(item)), client)
        return item

    async def records(self, kind, tenant=None, user=None, client=None):
        clauses, params = ["kind=%s"], [kind]
        for field, value in (("tenant_id", tenant), ("user_id", user)):
            if value is not None:
                clauses.append(field + "=%s")
                params.append(value)
        rows = await self.query("SELECT data FROM af_records WHERE " + " AND ".join(clauses) + " ORDER BY updated_at DESC,id", params, client)
        return [r["data"] for r in rows]

    async def list(self, kind, tenant, user=None):
        return (await self.records(kind, tenant, user))[:200]

    async def refund_get(self, key, client=None):
        rows = await self.query("SELECT data FROM af_refunds WHERE request_key=%s", (key,), client)
        return rows[0]["data"] if rows else None

    async def refund_put(self, receipt, client):
        await self.query("INSERT INTO af_refunds(request_key,case_id,data) VALUES(%s,%s,%s)", (receipt["requestKey"], receipt["caseId"], Jsonb(receipt)), client)

    async def refund_count(self):
        return (await self.query("SELECT count(*) AS count FROM af_refunds"))[0]["count"]

    async def session_save(self, token_hash, actor_id):
        await self.query("INSERT INTO af_sessions(token_hash,actor_id,expires_at) VALUES(%s,%s,now()+interval '1 day')", (token_hash, actor_id))

    async def session_actor(self, token_hash):
        rows = await self.query("SELECT actor_id FROM af_sessions WHERE token_hash=%s AND expires_at>now()", (token_hash,))
        return rows[0]["actor_id"] if rows else None

    async def reset_evaluation(self):
        rows = await self.query("SELECT current_database() AS name")
        if not rows[0]["name"].startswith("af_eval_"):
            raise AppError("评测数据重置仅允许临时评测数据库")
        await self.query("DELETE FROM af_refunds; DELETE FROM af_records WHERE kind IN ('case','conversation','material')")
        for order in seed_orders():
            await self.put("order", order)

    @asynccontextmanager
    async def transaction(self):
        async with self.pool.connection() as conn:
            async with conn.transaction():
                yield conn

    @asynccontextmanager
    async def locked(self, key):
        # 数据库执行锁跨进程有效。等待者先归还连接，避免占满池使执行者饿死。
        deadline = monotonic() + 15
        while True:
            conn = await self.pool.getconn()
            try:
                cursor = await conn.execute("SELECT pg_try_advisory_lock(hashtextextended(%s,0)) AS acquired", (key,))
                if (await cursor.fetchone())["acquired"]:
                    break
            except BaseException:
                await self.pool.putconn(conn)
                raise
            await self.pool.putconn(conn)
            if monotonic() >= deadline:
                raise AppError("这项操作正在处理中，请稍后刷新结果", 409)
            await asyncio.sleep(.05)
        try:
            yield
        finally:
            try:
                await conn.execute("SELECT pg_advisory_unlock(hashtextextended(%s,0))", (key,))
            finally:
                await self.pool.putconn(conn)

    async def close(self):
        await self.pool.close()

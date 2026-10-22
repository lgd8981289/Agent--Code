"""数据库适配器的连接协议测试；不打开 PostgreSQL 连接。"""

import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock
from server.storage import Storage


class Cursor:
    def __init__(self, rows, description=True):
        self.rows, self.description = rows, description
    async def fetchall(self): return self.rows
    async def fetchone(self): return self.rows[0]


class Connection:
    def __init__(self):
        self.calls, self.transactions = [], []
        self.results = []

    async def execute(self, sql, params=None):
        self.calls.append((sql, params))
        rows = self.results.pop(0) if self.results else []
        return Cursor(rows, bool(rows))

    @asynccontextmanager
    async def transaction(self):
        self.transactions.append("begin")
        try:
            yield
        except BaseException:
            self.transactions.append("rollback")
            raise
        else:
            self.transactions.append("commit")


class Pool:
    def __init__(self, connection):
        self.conn, self.returned = connection, []
    @asynccontextmanager
    async def connection(self): yield self.conn
    async def getconn(self): return self.conn
    async def putconn(self, conn): self.returned.append(conn)


class StorageTests(unittest.IsolatedAsyncioTestCase):
    def make(self):
        db, conn = Storage.__new__(Storage), Connection()
        db.pool = Pool(conn)
        db.saver = type("Saver", (), {"setup": AsyncMock()})()
        db.memories = type("Store", (), {"setup": AsyncMock()})()
        return db, conn

    async def test_setup_uses_simple_ddl_and_seed_does_not_overwrite(self):
        db, conn = self.make()
        await db.setup()
        self.assertIsNone(conn.calls[0][1])
        self.assertIn("af_sessions", conn.calls[0][0])
        seeds = [p for sql, p in conn.calls if "ON CONFLICT DO NOTHING" in sql]
        self.assertEqual([p[0] for p in seeds], ["A1024", "A1026", "A1025"])
        db.saver.setup.assert_awaited_once()
        db.memories.setup.assert_awaited_once()

    async def test_row_lock_and_transaction_rollback(self):
        db, conn = self.make()
        conn.results = [[{"data": {"id": "case"}}]]
        with self.assertRaisesRegex(RuntimeError, "rollback"):
            async with db.transaction() as client:
                self.assertEqual(await db.get("case", "case", client, True), {"id": "case"})
                raise RuntimeError("rollback")
        self.assertIn("FOR UPDATE", conn.calls[0][0])
        self.assertEqual(conn.transactions, ["begin", "rollback"])

    async def test_advisory_lock_returns_waiting_connection_and_unlocks_on_error(self):
        db, conn = self.make()
        conn.results = [[{"acquired": False}], [{"acquired": True}]]
        with self.assertRaisesRegex(RuntimeError, "business"):
            async with db.locked("case:fixture"):
                raise RuntimeError("business")
        self.assertEqual(len(db.pool.returned), 2)
        self.assertIn("pg_advisory_unlock", conn.calls[-1][0])

    async def test_evaluation_reset_refuses_business_database(self):
        db, conn = self.make()
        conn.results = [[{"name": "aftersales_agent"}]]
        with self.assertRaisesRegex(Exception, "临时"):
            await db.reset_evaluation()
        self.assertFalse(any("DELETE" in sql for sql, _ in conn.calls))

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'
import { DEFAULT_POSTGRES_URI } from '../storage/storage.service.js'

try {
	process.loadEnvFile()
} catch {
	// 未配置 .env 时使用课程默认 PostgreSQL 地址。
}

const uri = process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
const checkpointer = PostgresSaver.fromConnString(uri)
const store = PostgresStore.fromConnString(uri, { ensureTables: false })

try {
	await checkpointer.setup()
	await store.setup()
	console.log('数据库表结构初始化完成。')
} finally {
	await Promise.all([store.stop(), checkpointer.end()])
}

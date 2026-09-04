import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'

/** 读取本节共用的 PostgreSQL 连接地址。 */
function getPostgresUri() {
	if (!process.env.POSTGRES_URI) {
		throw new Error('缺少 POSTGRES_URI，请先在 .env 中完成配置。')
	}

	return process.env.POSTGRES_URI
}

/** 创建分别负责短期状态和长期记忆的 PostgreSQL 组件。 */
export function createStorage() {
	const uri = getPostgresUri()

	return {
		checkpointer: PostgresSaver.fromConnString(uri),
		store: PostgresStore.fromConnString(uri, { ensureTables: false })
	}
}

/** 关闭 Store 和 Checkpointer 各自持有的数据库连接池。 */
export async function closeStorage({ store, checkpointer }) {
	await Promise.all([store.stop(), checkpointer.end()])
}

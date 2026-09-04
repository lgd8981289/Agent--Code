import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'

/** 第一次运行项目前，创建 Checkpointer 和 Store 需要的数据表。 */
async function main() {
	if (!process.env.POSTGRES_URI) {
		throw new Error('缺少 POSTGRES_URI，请先在 .env 中完成配置。')
	}

	const checkpointer = PostgresSaver.fromConnString(process.env.POSTGRES_URI)
	const store = PostgresStore.fromConnString(process.env.POSTGRES_URI)

	try {
		await checkpointer.setup()
		await store.setup()
		console.log('Checkpointer 与 Store 数据表初始化完成。')
	} finally {
		await Promise.all([store.stop(), checkpointer.end()])
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

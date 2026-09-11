import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { DEFAULT_POSTGRES_URI } from '../storage/storage.service.js'

try {
	process.loadEnvFile()
} catch {
	// Replay 模式可以不创建 .env。
}

const uri = process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
const checkpointer = PostgresSaver.fromConnString(uri)

try {
	await checkpointer.setup()
	console.log('✓ PostgreSQL 连接正常')
	console.log(
		process.env.DEEPSEEK_API_KEY
			? `✓ AI 模式可用：${process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'}`
			: '· 未配置 DEEPSEEK_API_KEY，将使用 Replay 模式'
	)
} finally {
	await checkpointer.end()
}

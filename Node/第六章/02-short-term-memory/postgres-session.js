import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import {
	createMemoryAgent,
	createThreadConfig,
	printState
} from './session.js'

const mode = process.argv[2]
const supportedModes = new Set([
	'reset',
	'write',
	'continue',
	'unauthorized'
])

if (!supportedModes.has(mode)) {
	throw new Error(
		'命令参数必须是 reset、write、continue 或 unauthorized。请通过 npm scripts 运行。'
	)
}

/** 获取 PostgreSQL 连接地址，不在代码中保存真实生产凭证。 */
function getPostgresUri() {
	return (
		process.env.POSTGRES_URI ??
		'postgresql://agent_course:agent_course@localhost:5432/agent_memory'
	)
}

/** 向固定 Thread 写入第一轮消息，随后结束当前进程。 */
async function writeFirstTurn(agent) {
	const config = createThreadConfig('user-1001', 'support-postgres-1001')
	const state = await agent.invoke(
		{
			messages: [
				{
					role: 'user',
					content:
						'请记住：订单 A2048 当前缺少商品损坏照片，需要用户补充以后再审核。'
				}
			]
		},
		config
	)

	printState('第一次进程：写入 PostgreSQL', state)
	console.log('\n现在结束进程，再执行 npm run postgres:continue。')
}

/** 在新的 Node.js 进程中加载相同 Thread，并继续提问。 */
async function continueThread(agent) {
	const config = createThreadConfig('user-1001', 'support-postgres-1001')
	const stateBeforeInvoke = await agent.getState(config)

	printState('第二次进程：调用模型以前先恢复 State', stateBeforeInvoke.values)

	const stateAfterInvoke = await agent.invoke(
		{
			messages: [
				{
					role: 'user',
					content: '这个订单还缺少什么材料？'
				}
			]
		},
		config
	)

	printState('第二次进程：在恢复后的 State 上继续执行', stateAfterInvoke)
}

/** 验证其他用户不能借助已知 thread_id 读取会话。 */
async function verifyUnauthorizedAccess() {
	console.log('\n========== PostgreSQL 会话越权验证 ==========')

	try {
		createThreadConfig('user-1002', 'support-postgres-1001')
	} catch (error) {
		console.log(error.message)
	}
}

/** 只清理当前案例使用的 Thread，方便重复执行实验。 */
async function resetDemoThread(checkpointer) {
	await checkpointer.deleteThread('support-postgres-1001')
	console.log('已清理 Thread：support-postgres-1001')
}

/**
 * PostgreSQL Checkpointer 会把 Thread State 保存到数据库，
 * 因此 write 和 continue 可以在两个独立进程中执行。
 */
async function main() {
	if (mode === 'unauthorized') {
		await verifyUnauthorizedAccess()
		return
	}

	const checkpointer = PostgresSaver.fromConnString(getPostgresUri())

	try {
		await checkpointer.setup()

		if (mode === 'reset') {
			await resetDemoThread(checkpointer)
			return
		}

		const agent = createMemoryAgent(checkpointer)

		if (mode === 'write') {
			await writeFirstTurn(agent)
			return
		}

		await continueThread(agent)
	} finally {
		// fromConnString() 内部创建了连接池，脚本退出前需要主动释放。
		await checkpointer.end()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

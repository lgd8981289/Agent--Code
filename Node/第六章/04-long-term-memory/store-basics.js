import { InMemoryStore } from '@langchain/langgraph'
import {
	loadUserProfile,
	profileNamespace,
	saveUserProfile
} from './profile-store.js'

const userOne = {
	tenantId: 'bluewhale',
	userId: 'user-1001'
}

const userTwo = {
	tenantId: 'bluewhale',
	userId: 'user-1002'
}

/**
 * 不调用大模型，只验证 Store 的核心存储机制。
 *
 * 主要观察：
 * 1. Namespace：决定数据存放在哪个逻辑空间
 * 2. Key：决定 Namespace 下具体哪一条数据
 * 3. Value：真正保存的用户画像内容
 * 4. 跨 Thread：验证 Store 中的数据可以被其他 Thread 继续读取
 */
async function main() {
	// 创建内存 Store。
	// InMemoryStore 适合用于本地实验，数据只保存在当前进程内存中。
	const store = new InMemoryStore()

	console.log('\n========== Thread A：保存用户画像 ==========')
	console.log('Namespace：', profileNamespace(userOne))
	console.log('Key：current')

	// 写入 userOne 的长期用户画像。
	// 最终可以理解为：
	//
	// Namespace + Key -> Value
	//
	// profileNamespace(userOne) + "current"
	//              ↓
	//        用户画像对象
	await saveUserProfile(store, userOne, {
		responseLanguage: 'zh-CN',
		answerStyle: 'conclusion_first',
		contactWindow: '工作日 19:00 以后'
	})

	/**
	 * Thread B：
	 * 模拟新的会话 Thread。
	 *
	 * 虽然已经不是 Thread A，
	 * 但只要使用的是同一个 Store，并且 Namespace + Key 相同，
	 * 依然能够读取之前保存的用户画像。
	 */
	console.log('\n========== Thread B：同一用户读取 ==========')
	console.log(await loadUserProfile(store, userOne))

	/**
	 * Thread C：
	 * 换成另一个用户 userTwo 读取。
	 *
	 * userTwo 会使用自己的 Namespace，
	 * 因此不会读取到 userOne 保存的用户画像，
	 * 用来验证不同用户之间的数据隔离。
	 */
	console.log('\n========== Thread C：另一名用户读取 ==========')
	console.log(await loadUserProfile(store, userTwo))
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

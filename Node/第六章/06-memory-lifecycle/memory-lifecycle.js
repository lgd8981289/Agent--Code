import { InMemoryStore } from '@langchain/langgraph'
import { candidates, principal } from './scenarios.js'
import {
	applyMemoryCandidate,
	forgetMemory,
	getActiveMemory,
	memoryNamespace,
	recallMemories
} from './memory-manager.js'

/** 在每次操作后重新读取，观察后续模型输入能够使用的记忆。 */
async function showState(title, result, store, now) {
	console.log(`\n========== ${title} ==========`)
	console.dir(
		{
			处理结果: result,
			当前可用记忆: (await recallMemories(store, principal, now)).map(
				(memory) => ({
					key: memory.key,
					value: memory.value,
					revision: memory.revision,
					expiresAt: memory.expiresAt
				})
			)
		},
		{ depth: null }
	)
}

/** 顺着同一个用户的记忆变化，验证去重、纠正、过期和主动删除。 */
async function main() {
	const store = new InMemoryStore()
	const now = new Date('2026-09-06T12:00:00+08:00')
	const options = { now }

	let result = await applyMemoryCandidate(
		store,
		principal,
		candidates.initial,
		options
	)
	await showState('首次保存：以后默认使用 Node.js', result, store, now)

	result = await applyMemoryCandidate(
		store,
		principal,
		candidates.repeat,
		options
	)
	await showState('重复表达：后面还是用 nodejs', result, store, now)

	result = await applyMemoryCandidate(
		store,
		principal,
		candidates.temporary,
		options
	)
	await showState('临时要求：这一次请用 Python', result, store, now)

	const conflict = await applyMemoryCandidate(
		store,
		principal,
		candidates.correction,
		options
	)
	await showState('新旧值冲突：等待确认是否修改长期偏好', conflict, store, now)

	// 模拟用户在记忆管理界面确认将 revision 1 的偏好改为 Python。
	result = await applyMemoryCandidate(store, principal, candidates.correction, {
		now,
		confirmedRevision: conflict.currentRevision
	})
	await showState('用户确认：以后默认改为 Python', result, store, now)

	result = await applyMemoryCandidate(
		store,
		principal,
		candidates.repeat,
		options
	)
	await showState('延迟任务：重新处理修改前的旧消息', result, store, now)

	result = await applyMemoryCandidate(
		store,
		principal,
		candidates.contact,
		options
	)
	await showState('限时记忆：9 月 7 日结束前只通过邮件联系', result, store, now)

	// 推进测试时钟，不需要真实等待到过期时间。
	const afterExpiry = new Date('2026-09-08T00:00:00+08:00')
	await showState(
		'到期以后重新读取联系偏好',
		{
			Store中仍有记录: Boolean(
				await store.get(memoryNamespace(principal), 'contact_window')
			),
			正常读取结果: await getActiveMemory(
				store,
				principal,
				'contact_window',
				afterExpiry
			)
		},
		store,
		afterExpiry
	)

	// 另一条偏好用于验证删除只影响选中的字段。
	await applyMemoryCandidate(store, principal, candidates.language, {
		now: afterExpiry
	})
	result = await forgetMemory(
		store,
		principal,
		'preferred_runtime',
		afterExpiry
	)
	await showState(
		'用户删除默认运行环境偏好',
		{
			...result,
			Store原始读取: await store.get(
				memoryNamespace(principal),
				'preferred_runtime'
			)
		},
		store,
		afterExpiry
	)

	result = await applyMemoryCandidate(store, principal, candidates.correction, {
		now: afterExpiry
	})
	await showState('删除后：后台再次处理旧聊天记录', result, store, afterExpiry)

	const otherUser = { ...principal, userId: 'user-1002' }
	console.log('\n========== 换一名用户读取 ==========')
	console.dir(await recallMemories(store, otherUser, afterExpiry), {
		depth: null
	})
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

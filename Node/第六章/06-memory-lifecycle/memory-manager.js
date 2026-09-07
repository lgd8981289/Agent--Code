import { z } from 'zod'

export const MEMORY_KEYS = [
	'preferred_language',
	'preferred_runtime',
	'contact_window'
]

const keySchema = z.enum(MEMORY_KEYS)
const identitySchema = z.object({
	tenantId: z.string().min(1),
	userId: z.string().min(1)
})
const candidateSchema = z.object({
	key: keySchema,
	value: z.string().trim().min(1),
	scope: z.enum(['long_term', 'current_thread']),
	expiresAt: z.iso.datetime({ offset: true }).nullable(),
	source: z.object({
		threadId: z.string().min(1),
		messageId: z.string().min(1),
		observedAt: z.iso.datetime({ offset: true })
	})
})

/** 按服务端已认证的身份划分范围，调用方不能使用模型提供的身份。 */
export function memoryNamespace(principal, collection = 'lifecycle-memories') {
	const { tenantId, userId } = identitySchema.parse(principal)
	return ['agent-course', 'tenants', tenantId, 'users', userId, collection]
}

/** 将少量已知别名统一成相同取值；这里不做任意文本的语义判断。 */
function normalizeCandidate(input) {
	const candidate = candidateSchema.parse(input)
	const aliases =
		candidate.key === 'preferred_runtime'
			? {
					node: 'Node.js',
					nodejs: 'Node.js',
					'node.js': 'Node.js',
					python: 'Python'
				}
			: candidate.key === 'preferred_language'
				? { ts: 'TypeScript', typescript: 'TypeScript', python: 'Python' }
				: {}
	const alias = candidate.value.toLowerCase()
	if (Object.hasOwn(aliases, alias)) candidate.value = aliases[alias]
	return candidate
}

/** 判断业务有效期；expiresAt 是本项目字段，不是 Store 的自动清理配置。 */
export function isExpired(memory, now) {
	return (
		memory.expiresAt !== null && Date.parse(memory.expiresAt) <= now.getTime()
	)
}

/**
 * 接住上一节审核后的候选记忆，决定最终是：
 * - 新增
 * - 忽略
 * - 等待用户确认后更新
 *
 * 注意：
 * - confirmedRevision 只能来自应用层记录的“用户确认结果”，
 *   不能由记忆提取模型自行填写，否则模型可能绕过更新确认机制。
 * - 当前教学案例使用串行执行。
 *   如果多个进程可能同时修改同一条记忆，需要配合数据库事务、
 *   CAS（Compare-And-Swap）或其他原子版本检查机制。
 */
export async function applyMemoryCandidate(
	store,
	principal,
	input,
	{ now = new Date(), confirmedRevision } = {}
) {
	// 统一候选数据格式，确保后续生命周期判断使用规范化后的字段
	const candidate = normalizeCandidate(input)

	// 正常长期记忆使用的 Namespace
	const namespace = memoryNamespace(principal)

	// 删除后的生命周期阻断记录单独存放。
	// 一旦某个 key 被用户删除，这里可以阻止旧信息再次被自动写回。
	const blocks = memoryNamespace(principal, 'lifecycle-blocks')

	// 同一类记忆使用固定 key，例如 profile.language、profile.city 等
	const { key } = candidate

	// 1. 删除阻断检查：
	// 如果该 key 曾被用户明确删除，则不允许候选记忆再次自动写入
	if (await store.get(blocks, key)) {
		return { action: 'blocked_by_deletion' }
	}

	// 2. Scope 检查：
	// 只有 long_term 类型的候选才允许进入长期 Store，
	// 当前 Thread 临时信息只在当前会话中使用
	if (candidate.scope !== 'long_term') {
		return { action: 'current_thread_only' }
	}

	// 3. 过期检查：
	// 候选在真正写入前已经失效，就没有继续保存的必要
	if (isExpired(candidate, now)) {
		return { action: 'expired_candidate' }
	}

	// 4. 来源时间检查：
	// observedAt 表示这条信息实际出现的时间，
	// 不允许出现“未来消息”，避免错误时间影响后续新旧版本判断
	if (Date.parse(candidate.source.observedAt) > now.getTime()) {
		throw new Error('来源消息时间不能晚于当前处理时间。')
	}

	// 查询当前已经保存的同 key 记忆
	const item = await store.get(namespace, key)
	const current = item?.value

	// 5. 乐观锁 / Revision 校验：
	//
	// 用户确认修改时，应用层会把用户确认时看到的 revision
	// 作为 confirmedRevision 传回来。
	//
	// 如果此时 Store 中的 revision 已经发生变化，
	// 说明确认之后又有其他流程修改过这条数据。
	// 此时不能继续覆盖，否则可能造成并发更新丢失。
	if (
		confirmedRevision !== undefined &&
		confirmedRevision !== current?.revision
	) {
		return { action: 'stale_confirmation' }
	}

	// 如果已经存在同 key 记忆，
	// 接下来需要判断候选是重复信息、旧信息，还是新的修改
	if (current) {
		const sourceTime = Date.parse(candidate.source.observedAt)
		const previousTime = Date.parse(current.source.observedAt)

		// 候选信息比当前已保存信息更早：
		// 说明这是旧消息重新被提取出来，不允许覆盖新记忆
		if (sourceTime < previousTime) {
			return { action: 'stale_source' }
		}

		// value 和 expiresAt 都没有变化：
		// 认为是完全相同的记忆，不重复写入，也不增加 revision
		if (
			current.value === candidate.value &&
			current.expiresAt === candidate.expiresAt
		) {
			return {
				action: 'duplicate',
				revision: current.revision
			}
		}

		// 来源时间完全相同，但内容发生变化。
		// 这里不允许仅凭同一条来源消息产生的新提取结果覆盖旧结果，
		// 防止模型重新提取时产生不稳定结果。
		if (sourceTime === previousTime) {
			return { action: 'stale_source' }
		}

		// 已存在记忆，并且新的候选值发生了变化：
		//
		// 如果应用层还没有提供 confirmedRevision，
		// 说明用户尚未确认这次修改，因此暂时不能更新 Store。
		if (confirmedRevision === undefined) {
			return {
				action: 'needs_confirmation',

				// 当前已经保存的值
				currentValue: current.value,

				// 本次准备更新成的新值
				proposedValue: candidate.value,

				// 把当前版本号返回给应用层。
				// 用户确认之后，需要携带这个 revision 再次调用本函数。
				currentRevision: current.revision
			}
		}
	}

	// 能执行到这里，只有两种情况：
	//
	// 1. current 不存在：
	//    第一次创建这条长期记忆
	//
	// 2. current 已存在：
	//    候选信息更新，并且用户已经基于正确 revision 完成确认
	const memory = {
		value: candidate.value,
		source: candidate.source,
		expiresAt: candidate.expiresAt,

		// 首次创建时记录 createdAt；
		// 后续更新时保留原始创建时间
		createdAt: current?.createdAt ?? now.toISOString(),

		// 每次成功写入都刷新更新时间
		updatedAt: now.toISOString(),

		// revision 单调递增，用于识别并发更新和过期确认
		revision: (current?.revision ?? 0) + 1
	}

	// 写入最终通过生命周期检查的长期记忆
	await store.put(namespace, key, memory)

	// 根据之前是否已经存在记录，区分新增和更新
	return {
		action: current ? 'updated' : 'created',
		revision: memory.revision
	}
}

/**
 * 读取一条当前仍然“有效”的长期记忆。
 *
 * 所有正常读取都统一经过这里，从读取侧屏蔽：
 * - 已被用户删除的记忆
 * - 已经过期的记忆
 *
 * 注意：
 * 这里负责的是“是否允许读取”，
 * 并不一定意味着底层 Store 中对应的数据已经被物理删除。
 */
export async function getActiveMemory(store, principal, key, now = new Date()) {
	// 校验 Memory Key 的格式，
	// 防止非法 key 进入后续 Namespace 查询逻辑
	keySchema.parse(key)

	// 1. 先检查生命周期阻断记录。
	//
	// 用户删除某条记忆后，会在 lifecycle-blocks Namespace
	// 中留下对应的阻断记录。
	//
	// 即使正常 Memory Namespace 中还残留旧数据，
	// 只要 block 存在，这条记忆就不应该再次对外可见。
	const block = await store.get(
		memoryNamespace(principal, 'lifecycle-blocks'),
		key
	)

	if (block) {
		return null
	}

	// 2. 从当前用户正常的 Memory Namespace 中读取记忆
	const item = await store.get(memoryNamespace(principal), key)

	// 3. 以下两种情况都视为“当前没有可用记忆”：
	//
	// - Store 中根本不存在这条记忆
	// - 记忆虽然仍然存在，但 expiresAt 已经过期
	//
	// 过期数据这里采用读取时过滤，
	// 是否进行物理清理可以交给独立的 GC / Cleanup 机制处理。
	if (!item || isExpired(item.value, now)) {
		return null
	}

	// 返回统一的 Active Memory 结构：
	// key 来自 Store 索引，其余字段来自实际保存的 Memory Value
	return {
		key,
		...item.value
	}
}

/** 按本案例的三个固定字段读取有效记忆，不进行语义检索。 */
export async function recallMemories(store, principal, now = new Date()) {
	const memories = []
	for (const key of MEMORY_KEYS) {
		const memory = await getActiveMemory(store, principal, key, now)
		if (memory) memories.push(memory)
	}
	return memories
}

/**
 * 模拟用户删除入口：先阻止读写，再删除内容。重复执行可以重试未完成的删除。
 * 删除标记只保存控制信息，不保留旧偏好，也不作为模型上下文。
 */
export async function forgetMemory(store, principal, key, now = new Date()) {
	keySchema.parse(key)
	const blocks = memoryNamespace(principal, 'lifecycle-blocks')
	if (!(await store.get(blocks, key))) {
		await store.put(blocks, key, { blockedAt: now.toISOString() })
	}
	await store.delete(memoryNamespace(principal), key)
	return { action: 'deleted' }
}

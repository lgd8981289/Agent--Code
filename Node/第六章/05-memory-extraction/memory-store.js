import { randomUUID } from 'node:crypto'

/** 使用可信租户和用户身份确定长期记忆的 Namespace。 */
export function memoryNamespace(principal) {
	return [
		'agent-course',
		'tenants',
		principal.tenantId,
		'users',
		principal.userId,
		'extracted-memories'
	]
}

/** 只把审核通过的候选写入 Store，并重新读取以验证结果。 */
export async function saveAcceptedMemories(store, principal, reviews) {
	const saved = []
	const namespace = memoryNamespace(principal)

	for (const { candidate, decision } of reviews) {
		if (!decision.accepted) continue

		const key = randomUUID()
		const value = {
			content: candidate.content,
			category: candidate.category,
			sourceMessageId: candidate.sourceMessageId,
			evidenceQuote: candidate.evidenceQuote,
			createdAt: new Date().toISOString()
		}

		await store.put(namespace, key, value)
		const item = await store.get(namespace, key)
		saved.push({ key, value: item.value })
	}

	return saved
}

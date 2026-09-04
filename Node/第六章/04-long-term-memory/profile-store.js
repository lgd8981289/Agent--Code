const PROFILE_KEY = 'current'
const SAFE_ID = /^[a-zA-Z0-9_-]+$/

/** 校验应用程序传入的租户和用户身份，避免把任意文本拼进 Namespace。 */
function validatePrincipal(principal) {
	for (const [name, value] of Object.entries(principal)) {
		if (typeof value !== 'string' || !SAFE_ID.test(value)) {
			throw new Error(`${name} 只能包含字母、数字、下划线和短横线。`)
		}
	}
}

/**
 * 为一名用户生成固定的画像 Namespace。
 * Namespace 不包含 threadId，因此同一用户的不同 Thread 可以读取同一份画像。
 */
export function profileNamespace(principal) {
	validatePrincipal(principal)

	return [
		'agent-course',
		'tenants',
		principal.tenantId,
		'users',
		principal.userId,
		'profiles'
	]
}

/** 把当前用户画像保存为一个 JSON 文档。 */
export async function saveUserProfile(store, principal, profile) {
	const value = {
		...profile,
		updatedAt: new Date().toISOString()
	}

	await store.put(profileNamespace(principal), PROFILE_KEY, value)
	return value
}

/** 使用精确 Namespace 和固定 Key 读取当前用户画像。 */
export async function loadUserProfile(store, principal) {
	const item = await store.get(profileNamespace(principal), PROFILE_KEY)
	return item?.value ?? null
}

/** 删除当前用户画像，供课程实验恢复初始状态。 */
export async function deleteUserProfile(store, principal) {
	await store.delete(profileNamespace(principal), PROFILE_KEY)
}

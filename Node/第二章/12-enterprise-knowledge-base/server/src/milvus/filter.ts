import type { DemoUser } from '../auth/auth.types.js'

/** 转义 Filter 字符串中的反斜杠和双引号。 */
export function escapeFilterValue(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** 构造 Milvus 字符串字段的等值表达式。 */
export function equal(field: string, value: string): string {
	return `${field} == "${escapeFilterValue(value)}"`
}

/**
 * 根据服务端确认的用户身份生成检索权限条件。
 * 管理员可查看当前租户全部文档，员工只能查看企业公开和本部门文档。
 */
export function buildPermissionFilter(user: DemoUser): string {
	const tenant = equal('tenant_id', user.tenantId)
	const active = 'is_active == true'

	if (user.role === 'admin') {
		return `${tenant} and ${active}`
	}

	const department = equal('department_id', user.departmentId)
	return `${tenant} and ${active} and (visibility == "company" or ${department})`
}

/**
 * 构造指定租户和文档的查询条件，可选择只查询生效版本。
 */
export function buildDocumentFilter(
	tenantId: string,
	documentId: string,
	activeOnly = false
): string {
	const parts = [
		equal('tenant_id', tenantId),
		equal('document_id', documentId)
	]

	if (activeOnly) {
		parts.push('is_active == true')
	}

	return parts.join(' and ')
}

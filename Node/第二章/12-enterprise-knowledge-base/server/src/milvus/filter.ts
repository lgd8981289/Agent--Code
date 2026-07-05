import type { DemoUser } from '../auth/auth.types.js'

export function escapeFilterValue(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function equal(field: string, value: string): string {
	return `${field} == "${escapeFilterValue(value)}"`
}

export function buildPermissionFilter(user: DemoUser): string {
	const tenant = equal('tenant_id', user.tenantId)
	const active = 'is_active == true'

	if (user.role === 'admin') {
		return `${tenant} and ${active}`
	}

	const department = equal('department_id', user.departmentId)
	return `${tenant} and ${active} and (visibility == "company" or ${department})`
}

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

import type { DemoUser, DocumentSummary, QueryResult } from './types'

/**
 * 统一发送 API 请求并转换后端错误信息。
 * 业务方法只需要声明返回类型，不再重复处理 HTTP 状态码。
 */
async function request<T>(url: string, options?: RequestInit): Promise<T> {
	const response = await fetch(url, options)
	const body = (await response.json()) as unknown

	if (!response.ok) {
		const message =
			body && typeof body === 'object' && 'message' in body
				? (body as { message?: string | string[] }).message
				: undefined
		throw new Error(
			Array.isArray(message)
				? message.join('；')
				: message || `请求失败：${response.status}`
		)
	}

	return body as T
}

/** 构造演示身份使用的 Bearer Token 请求头。 */
function auth(token: string): HeadersInit {
	return { Authorization: `Bearer ${token}` }
}

/** 获取前端身份切换器使用的演示用户。 */
export function getUsers() {
	return request<DemoUser[]>('/api/session/users')
}

/** 获取后端服务状态。 */
export function getHealth() {
	return request<{ status: string }>('/api/health')
}

/** 根据当前身份获取有权访问的文档列表。 */
export function getDocuments(token: string) {
	return request<DocumentSummary[]>('/api/documents', {
		headers: auth(token)
	})
}

/**
 * 上传新文档或为已有文档发布新版本。
 * 是否携带 documentId 决定使用 POST 还是 PUT。
 */
export function saveDocument(options: {
	token: string
	file: File
	title: string
	departmentId: string
	visibility: 'company' | 'department'
	documentId?: string
}) {
	// 文件和 Metadata 一起通过 multipart/form-data 发送。
	const formData = new FormData()
	formData.set('file', options.file)
	formData.set('title', options.title)
	formData.set('departmentId', options.departmentId)
	formData.set('visibility', options.visibility)

	const url = options.documentId
		? `/api/documents/${options.documentId}`
		: '/api/documents'

	return request<{ status: string; reason?: string; document: DocumentSummary }>(
		url,
		{
			method: options.documentId ? 'PUT' : 'POST',
			headers: auth(options.token),
			body: formData
		}
	)
}

/** 删除已导入文档，后端会把它从正常检索范围中移除。 */
export function deleteDocument(token: string, documentId: string) {
	return request<{ status: string; reason?: string; document: DocumentSummary }>(
		`/api/documents/${documentId}`,
		{
			method: 'DELETE',
			headers: auth(token)
		}
	)
}

/** 提交问题并获取答案、来源和检索链路信息。 */
export function queryKnowledge(token: string, question: string) {
	return request<QueryResult>('/api/knowledge/query', {
		method: 'POST',
		headers: {
			...auth(token),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ question })
	})
}

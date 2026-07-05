import type { DemoUser, DocumentSummary, QueryResult } from './types'

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

function auth(token: string): HeadersInit {
	return { Authorization: `Bearer ${token}` }
}

export function getUsers() {
	return request<DemoUser[]>('/api/session/users')
}

export function getHealth() {
	return request<{ status: string }>('/api/health')
}

export function getDocuments(token: string) {
	return request<DocumentSummary[]>('/api/documents', {
		headers: auth(token)
	})
}

export function saveDocument(options: {
	token: string
	file: File
	title: string
	departmentId: string
	visibility: 'company' | 'department'
	documentId?: string
}) {
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

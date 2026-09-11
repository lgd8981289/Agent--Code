import type {
	Capabilities,
	DemoUser,
	InterviewState,
	LearningMemory,
	Profile,
	SessionSummary
} from './types'

async function request<T>(path: string, token?: string, init?: RequestInit) {
	const response = await fetch(`/api${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { 'x-demo-token': token } : {}),
			...init?.headers
		}
	})
	const result = await response.json().catch(() => null)
	if (!response.ok) {
		throw new Error(result?.message ?? `请求失败：HTTP ${response.status}`)
	}
	return result as T
}

export const api = {
	users: () => request<DemoUser[]>('/users'),
	capabilities: (token: string) => request<Capabilities>('/capabilities', token),
	profile: (token: string) => request<Profile>('/profile', token),
	updateProfile: (token: string, profile: Profile) =>
		request<Profile>('/profile', token, {
			method: 'PATCH',
			body: JSON.stringify(profile)
		}),
	memories: (token: string) => request<LearningMemory[]>('/memories', token),
	deleteMemory: (token: string, key: string) =>
		request(`/memories/${encodeURIComponent(key)}`, token, { method: 'DELETE' }),
	sessions: (token: string) => request<SessionSummary[]>('/sessions', token),
	createSession: (
		token: string,
		input: { kind: 'new' | 'review'; mode: 'replay' | 'ai' }
	) =>
		request<InterviewState>('/sessions', token, {
			method: 'POST',
			body: JSON.stringify(input)
		}),
	session: (token: string, id: string) =>
		request<InterviewState>(`/sessions/${id}`, token),
	answer: (token: string, id: string, answer: string) =>
		request<InterviewState>(`/sessions/${id}/answers`, token, {
			method: 'POST',
			body: JSON.stringify({ answer })
		}),
	next: (token: string, id: string) =>
		request<InterviewState>(`/sessions/${id}/next`, token, { method: 'POST' })
}

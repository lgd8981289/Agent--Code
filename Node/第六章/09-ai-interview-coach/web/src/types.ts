export interface DemoUser {
	tenantId: string
	userId: string
	name: string
	token: string
}

export interface Profile {
	experience: string
	targetRole: string
	focusTopics: string[]
	answerStyle: string
}

export interface SessionSummary {
	id: string
	title: string
	status: 'awaiting_answer' | 'turn_complete'
	topic: string
	mode: 'replay' | 'ai'
	kind: 'new' | 'review'
	turnNumber: number
	createdAt: string
	updatedAt: string
}

export interface LearningMemory {
	key: string
	topic: string
	title: string
	status: 'needs_review' | 'improving' | 'mastered'
	attempts: number
	correctCount: number
	lastVerdict: 'correct' | 'partial' | 'incorrect'
	lastAnswerSummary: string
	updatedAt: string
	nextReviewAt: string
}

export interface InterviewState {
	sessionId: string
	mode: 'replay' | 'ai'
	kind: 'new' | 'review'
	status: 'awaiting_answer' | 'turn_complete'
	profile: Profile
	messages: Array<{
		id: string
		role: 'assistant' | 'user'
		kind: 'question' | 'answer' | 'feedback'
		content: string
		createdAt: string
	}>
	currentQuestion: null | {
		id: string
		topic: string
		title: string
		prompt: string
	}
	lastEvaluation: null | {
		verdict: 'correct' | 'partial' | 'incorrect'
		reason: string
		gaps: string[]
	}
	lastFeedback: null | { content: string; sourceIds: string[] }
	evidence: Array<{
		id: string
		evidenceType: string
		title: string
		content: string
		url: string
	}>
	usedMemoryKeys: string[]
	turnNumber: number
	trace: string[]
}

export interface Capabilities {
	replay: boolean
	ai: boolean
	model: string
}

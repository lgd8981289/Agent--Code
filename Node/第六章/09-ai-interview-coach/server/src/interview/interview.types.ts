export type SessionMode = 'replay' | 'ai'
export type SessionKind = 'new' | 'review'
export type SessionStatus = 'awaiting_answer' | 'turn_complete'
export type Verdict = 'correct' | 'partial' | 'incorrect'

export interface InterviewProfile {
	experience: string
	targetRole: string
	focusTopics: string[]
	answerStyle: string
}

export interface InterviewMessage {
	id: string
	role: 'assistant' | 'user'
	kind: 'question' | 'answer' | 'feedback'
	content: string
	createdAt: string
}

export interface InterviewQuestion {
	id: string
	topic: string
	title: string
	prompt: string
	expectedPoints: string[]
	evidenceTypes: string[]
	followUpPrompt: string
}

export interface EvaluationResult {
	verdict: Verdict
	reason: string
	gaps: string[]
	requiredEvidence: string[]
}

export interface KnowledgeSource {
	id: string
	evidenceType: string
	title: string
	content: string
	url: string
}

export interface FeedbackResult {
	content: string
	sourceIds: string[]
}

export interface LearningMemory {
	key: string
	topic: string
	title: string
	status: 'needs_review' | 'improving' | 'mastered'
	attempts: number
	correctCount: number
	lastVerdict: Verdict
	lastAnswerSummary: string
	lastQuestionId: string
	sourceIds: string[]
	updatedAt: string
	nextReviewAt: string
}

export interface SessionSummary {
	id: string
	title: string
	status: SessionStatus
	topic: string
	mode: SessionMode
	kind: SessionKind
	turnNumber: number
	createdAt: string
	updatedAt: string
}

export interface InterviewStateView {
	sessionId: string
	mode: SessionMode
	kind: SessionKind
	status: SessionStatus
	profile: InterviewProfile
	messages: InterviewMessage[]
	currentQuestion: InterviewQuestion | null
	lastEvaluation: EvaluationResult | null
	lastFeedback: FeedbackResult | null
	evidence: KnowledgeSource[]
	usedMemoryKeys: string[]
	turnNumber: number
	trace: string[]
}

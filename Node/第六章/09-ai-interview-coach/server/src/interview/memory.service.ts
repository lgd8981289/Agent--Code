import { Inject, Injectable } from '@nestjs/common'
import type { Principal } from '../auth/auth.types.js'
import { StorageService } from '../storage/storage.service.js'
import type {
	InterviewProfile,
	LearningMemory,
	SessionSummary,
	Verdict
} from './interview.types.js'

type Namespace = string[]

function profileNamespace(principal: Principal): Namespace {
	return [principal.tenantId, principal.userId, 'profile']
}

function learningNamespace(principal: Principal): Namespace {
	return [principal.tenantId, principal.userId, 'learning-memories']
}

function sessionNamespace(principal: Principal): Namespace {
	return [principal.tenantId, principal.userId, 'interview-sessions']
}

function blockNamespace(principal: Principal): Namespace {
	return [principal.tenantId, principal.userId, 'memory-blocks']
}

function defaultProfile(principal: Principal): InterviewProfile {
	if (principal.userId === 'user-chenzhou') {
		return {
			experience: '2 年 Node.js 后端开发',
			targetRole: 'Agent 后端开发工程师',
			focusTopics: ['Agent Runtime', 'Tool Calling', 'RAG'],
			answerStyle: '先让我完整回答，再给出具体反馈'
		}
	}

	return {
		experience: '3 年前端开发',
		targetRole: 'AI 应用开发工程师',
		focusTopics: ['Agent Memory', 'RAG', 'LangGraph'],
		answerStyle: '一次只问一道题，回答后再继续追问'
	}
}

function addDays(date: Date, days: number) {
	const next = new Date(date)
	next.setUTCDate(next.getUTCDate() + days)
	return next.toISOString()
}

/** 管理用户画像、训练记录、记忆阻断和会话索引。 */
@Injectable()
export class InterviewMemoryService {
	constructor(
		@Inject(StorageService) private readonly storage: StorageService
	) {}

	async getProfile(principal: Principal) {
		const namespace = profileNamespace(principal)
		const item = await this.storage.store.get(namespace, 'current')
		if (item) return item.value as InterviewProfile

		const profile = defaultProfile(principal)
		await this.storage.store.put(namespace, 'current', { ...profile })
		return profile
	}

	/**
	 * 更新当前用户的面试训练画像。
	 *
	 * 采用“读取当前值 + 局部覆盖”的方式更新，
	 * 未出现在 patch 中的字段会继续保留原值。
	 */
	async updateProfile(principal: Principal, patch: Partial<InterviewProfile>) {
		// 读取当前用户已经保存的 Profile
		const current = await this.getProfile(principal)

		// 基于现有 Profile 合并本次需要修改的字段
		const next: InterviewProfile = {
			...current,
			...patch,

			// focusTopics 没有传入时继续保留原值，
			// 避免被 undefined 意外覆盖
			focusTopics: patch.focusTopics ?? current.focusTopics
		}

		// 使用固定 Key `current` 覆盖保存该用户最新的 Profile
		await this.storage.store.put(profileNamespace(principal), 'current', {
			...next
		})

		// 返回更新后的完整 Profile
		return next
	}

	async listLearningMemories(principal: Principal) {
		const items = await this.storage.store.search(
			learningNamespace(principal),
			{
				limit: 100
			}
		)
		return items
			.map((item) => item.value as LearningMemory)
			.sort((left, right) => {
				const order = { needs_review: 0, improving: 1, mastered: 2 }
				return (
					order[left.status] - order[right.status] ||
					right.updatedAt.localeCompare(left.updatedAt)
				)
			})
	}

	/**
	 * 获取当前最适合用于复测的长期学习记忆。
	 *
	 * 选择优先级：
	 * 1. needs_review：仍然需要重点复习的薄弱项
	 * 2. improving：已经有所改善，但还需要继续巩固
	 * 3. 如果都不存在，则返回 null
	 */
	async getReviewMemory(principal: Principal) {
		// 读取当前用户保存的全部学习记忆
		const memories = await this.listLearningMemories(principal)

		return (
			// 优先选择仍然需要复习的记忆
			memories.find((memory) => memory.status === 'needs_review') ??
			// 没有 needs_review 时，再选择正在改善中的记忆
			memories.find((memory) => memory.status === 'improving') ??
			// 没有可用于复测的学习记忆
			null
		)
	}

	async recordTrainingResult(
		principal: Principal,
		input: {
			topic: string
			title: string
			verdict: Verdict
			answerSummary: string
			questionId: string
			sourceIds: string[]
			struggled: boolean
		}
	) {
		const key = input.topic
		const blocked = await this.storage.store.get(blockNamespace(principal), key)
		if (blocked) return null

		const namespace = learningNamespace(principal)
		const existingItem = await this.storage.store.get(namespace, key)
		const existing = existingItem?.value as LearningMemory | undefined
		const now = new Date()
		const correctCount =
			(existing?.correctCount ?? 0) + (input.verdict === 'correct' ? 1 : 0)
		const status: LearningMemory['status'] =
			input.verdict !== 'correct'
				? 'needs_review'
				: input.struggled || existing?.status === 'needs_review'
					? 'improving'
					: 'mastered'
		const reviewAfterDays =
			status === 'needs_review' ? 1 : status === 'improving' ? 3 : 14

		const memory: LearningMemory = {
			key,
			topic: input.topic,
			title: input.title,
			status,
			attempts: (existing?.attempts ?? 0) + 1,
			correctCount,
			lastVerdict: input.verdict,
			lastAnswerSummary: input.answerSummary.slice(0, 180),
			lastQuestionId: input.questionId,
			sourceIds: input.sourceIds,
			updatedAt: now.toISOString(),
			nextReviewAt: addDays(now, reviewAfterDays)
		}

		await this.storage.store.put(namespace, key, { ...memory })
		return memory
	}

	/** 删除指定训练记忆，并阻止后台再次自动写入同一主题。 */
	async forgetLearningMemory(principal: Principal, key: string) {
		await this.storage.store.put(blockNamespace(principal), key, {
			blockedAt: new Date().toISOString()
		})
		await this.storage.store.delete(learningNamespace(principal), key)
	}

	async saveSession(principal: Principal, session: SessionSummary) {
		await this.storage.store.put(sessionNamespace(principal), session.id, {
			...session
		})
		return session
	}

	async getSession(principal: Principal, sessionId: string) {
		const item = await this.storage.store.get(
			sessionNamespace(principal),
			sessionId
		)
		return (item?.value as SessionSummary | undefined) ?? null
	}

	async listSessions(principal: Principal) {
		const items = await this.storage.store.search(sessionNamespace(principal), {
			limit: 100
		})
		return items
			.map((item) => item.value as SessionSummary)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
	}
}

import {
	BadRequestException,
	ForbiddenException,
	Inject,
	Injectable,
	NotFoundException
} from '@nestjs/common'
import type { Principal } from '../auth/auth.types.js'
import { InterviewGraphService } from './interview-graph.service.js'
import { InterviewMemoryService } from './memory.service.js'
import { InterviewModelService } from './model.service.js'
import type {
	SessionKind,
	SessionMode,
	SessionSummary
} from './interview.types.js'

/** 将 HTTP 操作转换成会话、Graph 和长期记忆操作。 */
@Injectable()
export class InterviewService {
	constructor(
		@Inject(InterviewGraphService)
		private readonly graph: InterviewGraphService,
		@Inject(InterviewMemoryService)
		private readonly memories: InterviewMemoryService,
		@Inject(InterviewModelService)
		private readonly models: InterviewModelService
	) {}

	capabilities() {
		return {
			replay: true,
			ai: this.models.hasAiMode(),
			model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'
		}
	}

	/**
	 * 创建一个新的面试 Session，并启动对应的 Agent Graph。
	 *
	 * 主要流程：
	 * 1. 确定会话类型和运行模式
	 * 2. 校验 AI 模式是否可用
	 * 3. 读取用户长期记忆中的面试画像
	 * 4. 创建并保存 Session
	 * 5. 向 Graph 发送 start 事件，启动面试流程
	 * 6. 将 Graph 最新状态同步回 Session
	 * 7. 转换成前端需要的 View 返回
	 */
	async createSession(
		principal: Principal,
		input: { kind?: SessionKind; mode?: SessionMode }
	) {
		// 未指定时默认创建普通新面试，并使用 replay 模式运行
		const kind = input.kind ?? 'new'
		const mode = input.mode ?? 'replay'

		// AI 模式依赖真实的大模型服务。
		// 如果当前环境没有配置模型 API Key，则不允许启动 AI 模式。
		if (mode === 'ai' && !this.models.hasAiMode()) {
			throw new BadRequestException('AI 模式需要配置 DEEPSEEK_API_KEY。')
		}

		// 从长期记忆中读取当前用户的面试画像。
		// 后续会根据目标岗位、重点方向等信息生成本次面试内容。
		const profile = await this.memories.getProfile(principal)

		// 为本次面试创建独立 Session ID，并记录创建时间
		const id = crypto.randomUUID()
		const now = new Date().toISOString()

		/**
		 * 创建 Session 的持久化摘要。
		 *
		 * review：针对历史薄弱点进行专项复测
		 * new：根据用户画像开启一轮新的专项面试
		 */
		const session: SessionSummary = {
			id,
			title:
				kind === 'review' ? '薄弱点专项复测' : `${profile.targetRole}专项面试`,

			// Session 创建完成后，下一步等待用户回答第一道题
			status: 'awaiting_answer',

			// 复测场景的具体 Topic 会在后续流程中确定；
			// 普通面试优先使用用户画像中的第一个重点方向
			topic: kind === 'review' ? '待复测' : (profile.focusTopics[0] ?? 'Agent'),

			mode,
			kind,

			// 当前还没有完成任何一轮问答
			turnNumber: 0,

			createdAt: now,
			updatedAt: now
		}

		// 先保存 Session 基础信息，建立本次面试的持久化记录
		await this.memories.saveSession(principal, session)

		/**
		 * 向 Agent Graph 发送 start 事件，正式启动面试工作流。
		 *
		 * principal 和 sessionId 用于确定用户身份以及当前会话；
		 * profile 则作为 Graph 初始化时需要的用户画像上下文。
		 */
		const state = await this.graph.invoke(principal, id, {
			event: 'start',
			sessionId: id,
			mode,
			kind,
			profile
		})

		// Graph 执行后可能已经生成第一道题、更新 Topic 或修改 Session 状态，
		// 因此需要把最新 Graph State 同步回 Session 持久化数据。
		await this.syncSession(principal, session, state)

		// 将内部 Graph State 转换成前端可以直接消费的 View Model
		return this.graph.toView(state)
	}

	async getSession(principal: Principal, sessionId: string) {
		await this.requireSession(principal, sessionId)
		const state = await this.graph.getState(principal, sessionId)
		if (!state?.sessionId) throw new NotFoundException('会话状态不存在。')
		return this.graph.toView(state)
	}

	/**
	 * 处理用户提交的当前题目回答，并继续推进面试流程。
	 */
	async answer(principal: Principal, sessionId: string, answer: string) {
		// 校验当前用户是否有权限访问该 Session，并获取会话基本信息
		const session = await this.requireSession(principal, sessionId)

		// 从 Graph Checkpointer 中读取当前面试状态
		const current = await this.graph.getState(principal, sessionId)

		// 只有 Graph 正处于“等待用户回答”状态时，才允许继续提交答案
		if (current.status !== 'awaiting_answer') {
			throw new BadRequestException('当前没有等待回答的题目。')
		}

		// 防止提交空字符串或只有空白字符的回答
		if (!answer?.trim()) {
			throw new BadRequestException('回答不能为空。')
		}

		// 将本次回答作为 answer 事件重新送入 Graph，
		// Graph 会基于已有 Session 状态继续执行后续节点
		const state = await this.graph.invoke(principal, sessionId, {
			event: 'answer',
			answer: answer.trim()
		})

		// 将 Graph 最新状态同步到 Session，用于更新会话进度、标题、状态等信息
		await this.syncSession(principal, session, state)

		// 将内部 GraphState 转换成前端需要的视图数据并返回
		return this.graph.toView(state)
	}

	async next(principal: Principal, sessionId: string) {
		const session = await this.requireSession(principal, sessionId)
		const current = await this.graph.getState(principal, sessionId)
		if (current.status !== 'turn_complete') {
			throw new BadRequestException('请先完成当前题目。')
		}

		const state = await this.graph.invoke(principal, sessionId, {
			event: 'next'
		})
		await this.syncSession(principal, session, state)
		return this.graph.toView(state)
	}

	private async requireSession(principal: Principal, sessionId: string) {
		const session = await this.memories.getSession(principal, sessionId)
		if (!session) {
			throw new ForbiddenException('会话不存在，或当前用户无权访问。')
		}
		return session
	}

	private async syncSession(
		principal: Principal,
		session: SessionSummary,
		state: Awaited<ReturnType<InterviewGraphService['invoke']>>
	) {
		await this.memories.saveSession(principal, {
			...session,
			status: state.status,
			topic: state.currentQuestion?.title ?? session.topic,
			turnNumber: state.turnNumber,
			updatedAt: new Date().toISOString()
		})
	}
}

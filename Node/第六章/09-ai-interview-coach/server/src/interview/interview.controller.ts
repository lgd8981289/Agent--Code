import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	Patch,
	Post,
	UseGuards
} from '@nestjs/common'
import { CurrentPrincipal } from '../auth/current-principal.decorator.js'
import { DemoAuthGuard } from '../auth/demo-auth.guard.js'
import type { Principal } from '../auth/auth.types.js'
import { InterviewMemoryService } from './memory.service.js'
import { InterviewService } from './interview.service.js'
import type {
	InterviewProfile,
	SessionKind,
	SessionMode
} from './interview.types.js'

@Controller()
@UseGuards(DemoAuthGuard)
export class InterviewController {
	constructor(
		@Inject(InterviewService) private readonly interviews: InterviewService,
		@Inject(InterviewMemoryService)
		private readonly memoryStore: InterviewMemoryService
	) {}

	@Get('capabilities')
	capabilities() {
		return this.interviews.capabilities()
	}

	@Get('profile')
	profile(@CurrentPrincipal() principal: Principal) {
		return this.memoryStore.getProfile(principal)
	}

	@Patch('profile')
	updateProfile(
		@CurrentPrincipal() principal: Principal,
		@Body() patch: Partial<InterviewProfile>
	) {
		return this.memoryStore.updateProfile(principal, patch)
	}

	@Get('memories')
	memories(@CurrentPrincipal() principal: Principal) {
		return this.memoryStore.listLearningMemories(principal)
	}

	@Delete('memories/:key')
	async deleteMemory(
		@CurrentPrincipal() principal: Principal,
		@Param('key') key: string
	) {
		await this.memoryStore.forgetLearningMemory(principal, key)
		return { deleted: true, key }
	}

	@Get('sessions')
	sessions(@CurrentPrincipal() principal: Principal) {
		return this.memoryStore.listSessions(principal)
	}

	/**
	 * 创建面试会话
	 * @param principal
	 * @param input
	 * @returns
	 */
	@Post('sessions')
	createSession(
		@CurrentPrincipal() principal: Principal,
		@Body() input: { kind?: SessionKind; mode?: SessionMode }
	) {
		return this.interviews.createSession(principal, input)
	}

	@Get('sessions/:id')
	getSession(
		@CurrentPrincipal() principal: Principal,
		@Param('id') id: string
	) {
		return this.interviews.getSession(principal, id)
	}

	/**
	 * 提交当前面试会话的一次回答。
	 *
	 * 从请求中获取：
	 * - principal：当前登录用户身份
	 * - id：当前 Session ID
	 * - answer：用户本次提交的回答内容
	 *
	 * 具体的回答处理、状态推进等逻辑交给 InterviewsService 完成。
	 */
	@Post('sessions/:id/answers')
	answer(
		// 从当前请求上下文中获取可信用户身份
		@CurrentPrincipal() principal: Principal,

		// 获取路由中的会话 ID
		@Param('id') id: string,

		// 获取用户提交的回答内容
		@Body() input: { answer: string }
	) {
		// 将用户身份、会话 ID 和回答交给业务层处理
		return this.interviews.answer(principal, id, input.answer)
	}

	@Post('sessions/:id/next')
	next(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
		return this.interviews.next(principal, id)
	}
}

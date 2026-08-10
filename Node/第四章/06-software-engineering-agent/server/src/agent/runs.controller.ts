import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Inject,
	Param,
	Post
} from '@nestjs/common'
import { AgentRuntimeService } from './agent-runtime.service'
import { AgentProviderService } from './agent-provider.service'
import type { RunMode } from './agent.types'
import { SCENARIOS } from './scenarios'
import { ToolRegistryService } from './tool-registry.service'

@Controller()
export class RunsController {
	constructor(
		@Inject(AgentRuntimeService)
		private readonly runtime: AgentRuntimeService,
		@Inject(AgentProviderService)
		private readonly providers: AgentProviderService,
		@Inject(ToolRegistryService)
		private readonly tools: ToolRegistryService
	) {}

	@Get('health')
	health() {
		return { ok: true, service: 'software-engineering-agent' }
	}

	@Get('scenarios')
	listScenarios() {
		return SCENARIOS.map((scenario) => ({
			id: scenario.id,
			title: scenario.title,
			shortDescription: scenario.shortDescription,
			requirement: scenario.requirement,
			category: scenario.category,
			completionCriteria: scenario.completionCriteria
		}))
	}

	@Get('tools')
	listTools() {
		return this.tools.list()
	}

	@Get('capabilities')
	capabilities() {
		return this.providers.capabilities()
	}

	@Get('runs')
	listRuns() {
		return this.runtime.listRuns()
	}

	/**
	 * 创建一次新的 Agent Run。
	 *
	 * 请求体中必须提供场景 ID，并可选指定运行需求和执行模式。
	 */
	@Post('runs')
	async createRun(
		@Body()
		body: {
			scenarioId?: string
			requirement?: string
			mode?: RunMode
		}
	) {
		// 场景 ID 是创建 Run 的必要参数。
		if (!body.scenarioId) {
			throw new BadRequestException('scenarioId 不能为空。')
		}

		try {
			// 仅允许使用 AI 实时决策或 Replay 固定轨迹两种运行模式。
			if (body.mode && body.mode !== 'ai' && body.mode !== 'replay') {
				throw new Error('mode 只能是 ai 或 replay。')
			}

			// 将场景配置和用户输入交给 Runtime，创建并启动新的 Agent Run。
			return await this.runtime.createRun(body.scenarioId, {
				requirement: body.requirement,
				mode: body.mode
			})
		} catch (error) {
			// 将参数校验或 Runtime 抛出的异常转换为统一的 400 响应。
			throw new BadRequestException(toMessage(error))
		}
	}

	@Get('runs/:id')
	getRun(@Param('id') id: string) {
		try {
			return this.runtime.getRun(id)
		} catch (error) {
			throw new BadRequestException(toMessage(error))
		}
	}

	@Post('runs/:id/approval')
	async approve(@Param('id') id: string, @Body() body: { approved?: boolean }) {
		if (typeof body.approved !== 'boolean') {
			throw new BadRequestException('approved 必须是布尔值。')
		}

		try {
			return await this.runtime.decideApproval(id, body.approved)
		} catch (error) {
			throw new BadRequestException(toMessage(error))
		}
	}

	@Post('runs/:id/cancel')
	async cancel(@Param('id') id: string) {
		try {
			return await this.runtime.cancelRun(id)
		} catch (error) {
			throw new BadRequestException(toMessage(error))
		}
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : '请求处理失败。'
}

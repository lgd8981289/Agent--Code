import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { AgentRun, ProviderResult } from './agent.types'
import { getScenario } from './scenarios'

/** 使用固定决策轨迹复现实验，不依赖模型 API。 */
@Injectable()
export class ReplayProviderService {
	/**
	 * 根据当前 Run State 和场景预设的 Playbook，
	 * 返回下一条需要执行的决策。
	 *
	 * Replay 模式不会调用真实模型，而是按照预设顺序依次返回
	 * Action、Replan 或 Final 等决策。
	 */
	async next(run: AgentRun): Promise<ProviderResult> {
		// 获取当前运行对应的场景配置。
		const scenario = getScenario(run.scenarioId)

		// 根据游标读取本轮需要执行的预设决策。
		const template = scenario.playbook[run.playbookCursor]
		console.log('template', template)
		// Playbook 已经全部执行完毕时，返回最终决策。
		if (!template) {
			return {
				decision: { type: 'final', summary: '场景决策已经执行完毕。' },
				source: 'replay',
				model: null
			}
		}

		// 将预设的 Action 模板转换成一次真实的工具调用决策。
		if (template.type === 'action') {
			return {
				decision: {
					type: 'action',
					action: {
						// 每次 Action 都生成独立 ID，用于关联后续 Observation。
						id: randomUUID(),
						toolName: template.toolName,

						// 深拷贝参数，避免运行期间修改场景中的原始模板。
						arguments: structuredClone(template.arguments),
						stepId: template.stepId,
						reasoning: template.reasoning,
						completesStepIds: template.completesStepIds,
						recovery: template.recovery
					}
				},
				source: 'replay',
				model: null
			}
		}

		// Replan 决策需要关联导致本次重新规划的失败证据。
		if (template.type === 'replan') {
			// 从后向前查找最近一次校验未通过的 Observation。
			const latestFailure = [...run.observations]
				.reverse()
				.find((item) => item.data.passed === false)

			return {
				decision: {
					// 拷贝 Replan 模板，避免修改原始场景配置。
					...structuredClone(template),

					// 优先使用模板指定的证据，否则自动关联最近一次失败记录。
					evidenceIds:
						template.evidenceIds ?? (latestFailure ? [latestFailure.id] : [])
				},
				source: 'replay',
				model: null
			}
		}

		// 其他类型的决策，例如 Final，直接复制模板并返回。
		return {
			decision: structuredClone(template),
			source: 'replay',
			model: null
		}
	}
}

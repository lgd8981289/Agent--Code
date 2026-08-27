import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage } from 'langchain'

/**
 * 使用固定脚本模拟模型输出，让每次源码实验都得到相同的 Tool Call。
 * 本文件只负责提供稳定测试数据，不属于课程需要掌握的 Agent 逻辑。
 */
export class ScriptedToolCallingModel extends BaseChatModel {
	constructor({ mode = 'normal' } = {}) {
		super({})
		this.mode = mode
		this.turn = 0
	}

	_llmType() {
		return 'scripted-tool-calling-model'
	}

	/**
	 * createAgent 会在每一轮调用前绑定 Tool。
	 * 模拟模型不需要真正读取 Tool Schema，因此直接返回当前实例。
	 */
	bindTools() {
		return this
	}

	async _generate() {
		this.turn += 1
		const message =
			this.mode === 'error'
				? this.#createErrorMessage()
				: this.#createNormalMessage()

		return {
			generations: [
				{
					text: String(message.content ?? ''),
					message
				}
			],
			llmOutput: {}
		}
	}

	#createNormalMessage() {
		if (this.turn === 1) {
			return new AIMessage({
				content: '',
				tool_calls: [
					{
						name: 'get_task',
						args: { taskId: 'TASK-1024' },
						id: 'call_get_task',
						type: 'tool_call'
					}
				]
			})
		}

		if (this.turn === 2) {
			return new AIMessage({
				content: '',
				tool_calls: [
					{
						name: 'get_test_report',
						args: { taskId: 'TASK-1024' },
						id: 'call_get_report',
						type: 'tool_call'
					}
				]
			})
		}

		return new AIMessage(
			'TASK-1024 当前为 active，最近一次测试共 18 项，已经全部通过。'
		)
	}

	#createErrorMessage() {
		if (this.turn === 1) {
			return new AIMessage({
				content: '',
				tool_calls: [
					{
						name: 'get_task',
						args: { taskId: 1024 },
						id: 'call_invalid_task',
						type: 'tool_call'
					}
				]
			})
		}

		if (this.turn === 2) {
			return new AIMessage({
				content: '',
				tool_calls: [
					{
						name: 'get_task',
						args: { taskId: 'TASK-1024' },
						id: 'call_retry_task',
						type: 'tool_call'
					}
				]
			})
		}

		return new AIMessage(
			'第一次参数类型错误。修正参数以后，已经查到 TASK-1024 当前为 active。'
		)
	}
}

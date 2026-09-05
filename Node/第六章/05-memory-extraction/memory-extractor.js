import { ChatDeepSeek } from '@langchain/deepseek'
import { z } from 'zod'

export const candidateSchema = z.object({
	candidates: z.array(
		z.object({
			content: z.string().describe('整理后的候选记忆'),
			category: z
				.enum(['preference', 'fact'])
				.describe('候选属于用户偏好还是用户事实'),
			duration: z
				.enum(['long_term', 'current_thread', 'uncertain'])
				.describe('信息适合长期使用、只在当前会话使用，或者无法确认'),
			sourceMessageId: z.string().describe('候选记忆来自哪一条消息'),
			evidenceQuote: z.string().describe('从来源消息中原样复制的证据，不得改写')
		})
	)
})

/** 创建负责生成候选记忆的结构化输出模型。 */
export function createMemoryExtractor() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	const model = new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 2,
		modelKwargs: {
			thinking: { type: 'disabled' }
		}
	})

	return model.withStructuredOutput(candidateSchema, {
		name: 'extract_memory_candidates'
	})
}

/** 从对话中提出候选记忆，不在此处直接写入 Store。 */
export async function extractMemoryCandidates(extractor, messages) {
	const response = await extractor.invoke([
		{
			role: 'system',
			content: `你负责从对话中提出候选长期记忆，但没有最终保存权限。
分析用户偏好和用户事实，同时保留临时要求、未确认说法和敏感信息，让后续策略层决定是否保存。
duration 的判断规则：长期稳定信息使用 long_term；仅服务当前任务的信息使用 current_thread；转述、猜测或无法确认的信息使用 uncertain。
sourceMessageId 必须来自输入消息，evidenceQuote 必须从对应消息中原样复制。
不要把模型自己的推测改写成用户事实。`
		},
		{
			role: 'user',
			content: `请从下面的消息中提取候选记忆：\n${JSON.stringify(
				messages,
				null,
				2
			)}`
		}
	])

	return response.candidates
}

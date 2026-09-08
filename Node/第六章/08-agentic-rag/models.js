import { ChatDeepSeek } from '@langchain/deepseek'
import * as z from 'zod'

const EvidenceTypeSchema = z.enum([
	'review_rule',
	'material_requirement',
	'arrival_rule',
	'maintenance_policy'
])

const RetrievalDecisionSchema = z.object({
	route: z.enum(['direct', 'retrieve', 'clarify']),
	requiredEvidence: z.array(EvidenceTypeSchema),
	clarificationQuestion: z.string().nullable(),
	reason: z.string()
})

const GroundedAnswerSchema = z.object({
	answer: z.string(),
	sourceIds: z.array(z.string()).min(1)
})

function createModel() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	return new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 2,
		timeout: 60000,
		modelKwargs: {
			thinking: { type: 'disabled' }
		}
	})
}

function readText(content) {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return String(content ?? '')
	return content
		.filter((block) => block?.type === 'text')
		.map((block) => block.text)
		.join('\n')
}

/** 创建真实模型服务，分别负责检索决策、直接回答和有依据的答案生成。 */
export function createModelServices() {
	const model = createModel()
	const decisionModel = model.withStructuredOutput(RetrievalDecisionSchema, {
		name: 'decide_retrieval'
	})
	const answerModel = model.withStructuredOutput(GroundedAnswerSchema, {
		name: 'generate_grounded_answer'
	})

	return {
		async decide(question) {
			return decisionModel.invoke([
				{
					role: 'system',
					content: `你负责判断用户问题是否需要查询蓝鲸科技知识库。

direct：改写、寒暄等不依赖企业事实的问题，不查询知识库。
clarify：回答所需的用户条件缺失，而且知识库无法替用户补全。例如询问是否需要人工审核，却没有提供退款金额。
retrieve：需要企业当前规则或历史资料。

requiredEvidence 只能使用：
- review_rule：退款金额和人工审核规则
- material_requirement：退款材料要求
- arrival_rule：退款到账时间
- maintenance_policy：保养政策

一个问题需要多类资料时，必须完整返回所有证据类型。clarify 时给出一个最小澄清问题；其他情况返回 null。不要直接回答用户问题。`
				},
				{ role: 'user', content: question }
			])
		},

		async direct(question) {
			const response = await model.invoke([
				{
					role: 'system',
					content: '完成不依赖企业知识的文字处理任务。不要声称查询过知识库。回答简洁。'
				},
				{ role: 'user', content: question }
			])
			return readText(response.content)
		},

		async answer({ question, evidence }) {
			return answerModel.invoke([
				{
					role: 'system',
					content: `只能根据应用提供的可用证据回答。
回答中的每个业务结论都必须有证据支持。
将实际使用的 Chunk ID 写入 sourceIds，应用程序会根据这些 ID 绑定并展示真实来源。
sourceIds 只能填写应用提供的 Chunk ID，不得编造。`
				},
				{
					role: 'user',
					content: `用户问题：${question}\n\n应用提供的可用证据：\n${JSON.stringify(evidence, null, 2)}`
				}
			])
		}
	}
}

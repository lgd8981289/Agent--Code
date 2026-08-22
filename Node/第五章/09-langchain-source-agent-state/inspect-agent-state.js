import {
	createAgent,
	createMiddleware,
	FakeToolCallingModel
} from 'langchain'
import { MessagesValue, StateSchema } from '@langchain/langgraph'
import { z } from 'zod'

/**
 * 本案例只检查 createAgent() 构建出来的 Schema，
 * 不需要向真实模型发送请求。
 */
const model = new FakeToolCallingModel({})

/**
 * 读取 StateSchema 中定义的字段名称。
 */
function getStateSchemaFields(schema) {
	return Object.keys(schema?.fields ?? {})
}

/**
 * 读取普通 Zod Object 中定义的字段名称。
 */
function getZodObjectFields(schema) {
	return Object.keys(schema?.shape ?? {})
}

/**
 * 打印 createAgent() 最终交给 LangGraph 的四类 Schema。
 *
 * builder 及下划线开头的属性属于框架内部结构，
 * 这里只用于源码学习，不应该在业务代码中依赖它们。
 */
function printAgentSchemas(title, agent) {
	const builder = agent.builder

	console.log(`\n${title}`)
	console.dir(
		{
			state: getStateSchemaFields(builder._schemaRuntimeDefinition),
			input: getStateSchemaFields(builder._inputRuntimeDefinition),
			output: getStateSchemaFields(builder._outputRuntimeDefinition),
			context: getZodObjectFields(builder._configRuntimeSchema)
		},
		{ depth: null }
	)
}

const basicAgent = createAgent({
	model,
	tools: []
})

printAgentSchemas('基础 Agent', basicAgent)

/**
 * 业务代码主动增加的 Agent State。
 */
const DeliveryRiskState = new StateSchema({
	messages: MessagesValue,
	taskId: z.string(),
	evidence: z.array(z.string()).default(() => [])
})

/**
 * Middleware 也可以声明自己运行期间需要的 State。
 */
const auditMiddleware = createMiddleware({
	name: 'AuditMiddleware',
	stateSchema: z.object({
		auditCount: z.number().default(0)
	})
})

/**
 * Runtime Context 与 Agent State 分开定义。
 */
const RuntimeContext = z.object({
	tenantId: z.string()
})

/**
 * responseFormat 会让最终输出增加 structuredResponse。
 */
const DeliveryRiskResult = z.object({
	riskLevel: z.enum(['low', 'medium', 'high']),
	reason: z.string()
})

const extendedAgent = createAgent({
	model,
	tools: [],
	stateSchema: DeliveryRiskState,
	contextSchema: RuntimeContext,
	responseFormat: DeliveryRiskResult,
	middleware: [auditMiddleware]
})

printAgentSchemas('加入自定义 State、Middleware、Context 和结构化输出以后', extendedAgent)

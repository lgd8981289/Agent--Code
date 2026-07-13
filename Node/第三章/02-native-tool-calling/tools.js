const { z } = require('zod')

/**
 * 使用内存中的 Map 模拟真实订单系统。
 *
 * 实际项目中，这里通常会替换成：
 * - 数据库查询
 * - 订单服务接口
 * - ERP 或第三方业务系统
 *
 * 当前案例只关注 Tool Calling 流程，因此不引入数据库。
 */
const orders = new Map([
	[
		'A1024',
		{
			orderId: 'A1024',
			status: 'delivered',
			productName: '咖啡机',
			productType: 'normal',
			daysSinceDelivered: 3,
			refundAmount: 3000
		}
	],
	[
		'A2048',
		{
			orderId: 'A2048',
			status: 'delivered',
			productName: '新鲜草莓',
			productType: 'fresh',
			daysSinceDelivered: 1,
			refundAmount: 99
		}
	]
])

/**
 * get_order 工具的参数结构。
 *
 * 模型调用 get_order 时，只需要提供订单号。
 */
const getOrderSchema = z.object({
	orderId: z
		.string()
		.regex(/^A\d{4}$/, '订单号格式必须类似 A1024')
		.describe('订单号，例如 A1024')
})

/**
 * check_refund_eligibility 工具的参数结构。
 *
 * 这些参数应该来自 get_order 返回的真实订单数据，
 * 不能由模型自行猜测。
 */
const refundCheckSchema = z.object({
	orderId: z
		.string()
		.regex(/^A\d{4}$/)
		.describe('订单号'),

	orderStatus: z
		.enum(['pending', 'delivered', 'cancelled'])
		.describe('订单当前状态'),

	productType: z
		.enum(['normal', 'fresh'])
		.describe('商品类型，normal 表示普通商品，fresh 表示生鲜'),

	daysSinceDelivered: z
		.number()
		.int()
		.nonnegative()
		.describe('签收后经过的天数'),

	refundAmount: z.number().nonnegative().describe('本次退款金额，单位为元')
})

/**
 * 将应用程序内部使用的 Zod Schema 转换成 JSON Schema。
 *
 * 大模型不能直接识别 Zod Schema，
 * Tool Calling 接口需要的是 JSON Schema 格式的 parameters。
 */
function toToolParameters(schema) {
	const { $schema, ...parameters } = z.toJSONSchema(schema, {
		target: 'draft-7'
	})

	// 删除顶层的 $schema 字段，只保留工具参数定义。
	return parameters
}

/**
 * 提供给大模型的工具说明。
 *
 * 模型只能看到：
 * - 工具名称
 * - 工具描述
 * - 参数结构
 *
 * 模型看不到 toolRegistry 中的真实执行函数，
 * 也不能直接访问订单数据。
 */
const tools = [
	{
		type: 'function',
		function: {
			name: 'get_order',
			description:
				'根据订单号查询订单实时信息。判断退款条件之前必须先调用这个工具，不能猜测订单状态。',
			parameters: toToolParameters(getOrderSchema)
		}
	},
	{
		type: 'function',
		function: {
			name: 'check_refund_eligibility',
			description:
				'根据 get_order 返回的真实订单字段判断是否允许退款，以及是否需要人工审核。',
			parameters: toToolParameters(refundCheckSchema)
		}
	}
]

/**
 * 应用程序内部的工具注册表。
 *
 * 它负责将模型返回的工具名称映射到：
 * - schema：参数校验规则
 * - execute：真实工具执行函数
 *
 * 这部分不会发送给大模型。
 */
const toolRegistry = {
	/**
	 * 查询订单真实信息。
	 */
	get_order: {
		schema: getOrderSchema,

		execute: async ({ orderId }) => {
			const order = orders.get(orderId)

			// 订单不存在时，返回结构化错误，方便模型理解失败原因。
			if (!order) {
				return {
					ok: false,
					error: {
						code: 'ORDER_NOT_FOUND',
						message: `没有找到订单 ${orderId}`
					}
				}
			}

			return {
				ok: true,
				order
			}
		}
	},

	/**
	 * 根据真实订单信息判断退款资格。
	 */
	check_refund_eligibility: {
		schema: refundCheckSchema,

		execute: async ({
			orderId,
			orderStatus,
			productType,
			daysSinceDelivered,
			refundAmount
		}) => {
			const order = orders.get(orderId)

			if (!order) {
				return createError('ORDER_NOT_FOUND', `没有找到订单 ${orderId}`)
			}

			/**
			 * Zod 只能校验参数类型和格式，
			 * 不能判断模型传入的数据是否与订单系统中的真实数据一致。
			 *
			 * 因此这里还要进行一次业务数据核对，
			 * 防止模型修改、猜测或错误传递订单字段。
			 */
			const mismatchedFields = [
				['orderStatus', orderStatus, order.status],
				['productType', productType, order.productType],
				['daysSinceDelivered', daysSinceDelivered, order.daysSinceDelivered],
				['refundAmount', refundAmount, order.refundAmount]
			]
				// 找出模型传入值和真实订单值不一致的字段。
				.filter(([, received, actual]) => received !== actual)

				// 最终只保留字段名称。
				.map(([field]) => field)

			if (mismatchedFields.length > 0) {
				return {
					ok: false,
					error: {
						code: 'ORDER_DATA_MISMATCH',
						message: '工具参数与订单系统中的真实数据不一致。',
						fields: mismatchedFields
					}
				}
			}

			/**
			 * 退款规则一：
			 * 只有已经签收的订单，才能进入签收后的退款判断流程。
			 */
			if (order.status !== 'delivered') {
				return {
					ok: true,
					orderId,
					refundable: false,
					reason: '订单尚未签收，不能进入签收后的退款流程。'
				}
			}

			/**
			 * 退款规则二：
			 * 生鲜商品不支持无理由退款。
			 */
			if (order.productType === 'fresh') {
				return {
					ok: true,
					orderId,
					refundable: false,
					reason: '生鲜商品不支持无理由退款。'
				}
			}

			/**
			 * 退款规则三：
			 * 普通商品只能在签收后 7 天内申请退款。
			 */
			if (order.daysSinceDelivered > 7) {
				return {
					ok: true,
					orderId,
					refundable: false,
					reason: '普通商品已经超过签收后 7 天的退款期限。'
				}
			}

			/**
			 * 退款规则四：
			 * 退款金额超过 2000 元时，需要进入人工审核。
			 */
			const needManualReview = order.refundAmount > 2000

			return {
				ok: true,
				orderId,

				// 前面的退款条件均已通过。
				refundable: true,

				// 是否需要人工审核。
				needManualReview,

				// 根据金额决定进入自动审核还是人工审核。
				reviewType: needManualReview ? 'manual' : 'automatic',

				reason: needManualReview
					? '满足退款条件，但退款金额超过 2000 元，需要人工审核。'
					: '满足退款条件，可以进入自动退款流程。'
			}
		}
	}
}

/**
 * 执行模型返回的单次工具调用。
 *
 * 完整流程：
 *
 * 1. 根据工具名称查找注册的工具
 * 2. 解析模型生成的 JSON 参数
 * 3. 使用 Zod 校验参数
 * 4. 调用应用程序中的真实工具函数
 * 5. 捕获异常并返回结构化错误
 */
async function executeToolCall(toolCall) {
	// 根据模型返回的工具名称，从注册表中找到真实工具。
	const registeredTool = toolRegistry[toolCall.function.name]

	if (!registeredTool) {
		return createError('TOOL_NOT_FOUND', '应用程序没有注册这个工具。')
	}

	let rawArguments

	/**
	 * 模型返回的 function.arguments 通常是 JSON 字符串，
	 * 需要先解析成 JavaScript 对象。
	 */
	try {
		rawArguments = JSON.parse(toolCall.function.arguments)
	} catch {
		return createError('INVALID_JSON_ARGUMENTS', '工具参数不是合法 JSON。')
	}

	/**
	 * 使用对应工具的 Zod Schema 校验参数。
	 *
	 * safeParse 不会直接抛出异常，
	 * 而是返回 success 和 data/error。
	 */
	const parsedArguments = registeredTool.schema.safeParse(rawArguments)

	if (!parsedArguments.success) {
		return createError(
			'INVALID_TOOL_ARGUMENTS',
			'工具参数没有通过 Zod 校验。',
			parsedArguments.error.issues
		)
	}

	/**
	 * 参数校验通过后，调用应用程序中的真实工具函数。
	 */
	try {
		return await registeredTool.execute(parsedArguments.data)
	} catch (error) {
		// 捕获真实工具执行过程中出现的未知异常。
		return createError(
			'TOOL_EXECUTION_FAILED',
			error instanceof Error ? error.message : String(error)
		)
	}
}

/**
 * 创建统一的工具错误返回结构。
 *
 * issues 是可选字段，主要用于返回 Zod 的详细校验问题。
 */
function createError(code, message, issues) {
	return {
		ok: false,
		error: {
			code,
			message,
			...(issues ? { issues } : {})
		}
	}
}

/**
 * 对外导出：
 *
 * tools：
 * 提供给大模型的工具定义。
 *
 * executeToolCall：
 * 接收模型生成的工具调用请求，并在应用程序中执行真实工具。
 */
module.exports = {
	tools,
	executeToolCall
}

/**
 * 文件作用：
 * 提供课程演示使用的用户身份、订单、物流和售后规则数据。
 *
 * 章节定位：【配套文件】
 *
 * 建议阅读：
 * 重点留意两个租户都存在 A1024，这组数据用于验证多租户隔离；
 * 其余内容了解数据结构即可。
 */

/**
 * 演示账号。
 *
 * token 只用于本地课程项目，真实项目应接入 OAuth、JWT
 * 或企业自己的身份认证系统。
 */
export const principalsByToken = new Map([
	[
		'token-blue-service',
		{
			userId: 'u-service-01',
			name: '蓝鲸客服小周',
			tenantId: 'blue-whale',
			role: 'customer_service'
		}
	],
	[
		'token-blue-finance',
		{
			userId: 'u-finance-01',
			name: '蓝鲸财务小林',
			tenantId: 'blue-whale',
			role: 'finance'
		}
	],
	[
		'token-star-service',
		{
			userId: 'u-star-01',
			name: '星河客服小李',
			tenantId: 'star-retail',
			role: 'customer_service'
		}
	]
])

/**
 * 项目内置的订单数据。
 *
 * 两个租户都存在 A1024，用来验证查询条件是否真正包含 tenantId。
 */
export const orders = [
	{
		tenantId: 'blue-whale',
		orderId: 'A1024',
		productName: '全自动咖啡机',
		category: 'normal',
		amount: 3000,
		status: 'delivered',
		signedDays: 3,
		customerName: '王先生'
	},
	{
		tenantId: 'blue-whale',
		orderId: 'A1025',
		productName: '降噪耳机',
		category: 'normal',
		amount: 699,
		status: 'delivered',
		signedDays: 2,
		customerName: '陈女士'
	},
	{
		tenantId: 'blue-whale',
		orderId: 'A1026',
		productName: '冷鲜牛排',
		category: 'fresh',
		amount: 199,
		status: 'delivered',
		signedDays: 1,
		customerName: '赵先生'
	},
	{
		tenantId: 'star-retail',
		orderId: 'A1024',
		productName: '学习平板',
		category: 'normal',
		amount: 1899,
		status: 'shipped',
		signedDays: 0,
		customerName: '孙女士'
	}
]

export const logistics = [
	{
		tenantId: 'blue-whale',
		orderId: 'A1024',
		company: '顺丰速运',
		trackingNo: 'SFCOURSE1024',
		events: [
			{ time: '2026-07-16 10:30', message: '商品已签收' },
			{ time: '2026-07-16 08:10', message: '快件派送中' }
		]
	},
	{
		tenantId: 'star-retail',
		orderId: 'A1024',
		company: '京东物流',
		trackingNo: 'JDCOURSE1024',
		events: [{ time: '2026-07-20 16:20', message: '商品运输中' }]
	}
]

export const policies = [
	{
		tenantId: 'blue-whale',
		code: 'refund-policy',
		title: '蓝鲸科技退款规则',
		content: [
			'普通商品签收后 7 天内可以申请退款。',
			'生鲜商品不支持无理由退款。',
			'退款金额超过 2000 元时，必须进入人工审核。'
		].join('\n')
	},
	{
		tenantId: 'blue-whale',
		code: 'logistics-policy',
		title: '蓝鲸科技物流异常处理规则',
		content: '物流超过 72 小时没有更新时，客服可以创建物流核查工单。'
	},
	{
		tenantId: 'star-retail',
		code: 'refund-policy',
		title: '星河零售退款规则',
		content:
			'普通商品签收后 15 天内可以申请退款，金额超过 5000 元时进入人工审核。'
	}
]

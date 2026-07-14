// 使用 Map 模拟企业内部的订单数据存储。
// key 为订单号，value 为订单的详细信息。
const orders = new Map([
	[
		'A1024',
		{
			orderId: 'A1024',
			status: 'delivered',
			productName: '咖啡机',
			refundAmount: 3000
		}
	]
])

/**
 * 根据订单号查询订单信息。
 *
 * 这里用内存中的 Map 模拟真实企业订单系统；
 * 实际项目中通常会调用数据库、HTTP 接口或 RPC 服务。
 */
export async function getOrderById(orderId) {
	// 根据订单号查询对应的订单数据。
	const order = orders.get(orderId)

	// 没有查询到订单时，返回统一的失败结果。
	if (!order) {
		return {
			ok: false,
			error: {
				code: 'ORDER_NOT_FOUND',
				message: `没有找到订单 ${orderId}`
			}
		}
	}

	// 查询成功后返回订单信息。
	// 使用展开运算符复制一份对象，避免外部代码直接修改原始数据。
	return {
		ok: true,
		order: { ...order }
	}
}

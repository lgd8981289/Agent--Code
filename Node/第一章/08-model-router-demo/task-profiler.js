/**
 * 对任务进行分析和配置，帮助模型路由器做出更智能的决策
 */
function profileTask(task) {
	// 取出用户输入的文本，没有就用空字符串
	const text = task.userText || ''

	// 收集本次任务的输入类型：默认有 text，也可能有图片等附件
	const inputTypes = [
		'text',
		...(task.attachments || []).map((item) => item.type)
	]

	// 判断是否包含图片
	const hasImage = inputTypes.includes('image')

	// 判断是否有订单数据
	const hasOrder = Boolean(task.order)

	// 判断用户是否在问“金额是否超过阈值”
	const asksAmountCheck = text.includes('超过') && text.includes('阈值')

	// 判断用户是否提到了规则或流程
	const mentionsPolicy = text.includes('规则') || text.includes('流程')

	// 判断用户是否只是想改写内容或生成客服回复
	const asksRewrite = text.includes('改写') || text.includes('客服回复')

	// 有订单，并且用户问了阈值问题，就可以走确定性规则
	const deterministicRuleMatched = asksAmountCheck && hasOrder

	// 涉及规则或流程时，认为需要更多推理
	const reasoningComplexity = mentionsPolicy ? 'high' : 'low'

	// 涉及订单或退款时，认为风险较高
	const riskLevel = hasOrder || text.includes('退款') ? 'high' : 'low'

	// 返回分析后的任务信息
	return {
		id: task.id,
		userText: text,
		inputTypes,
		hasImage,
		hasOrder,
		asksRewrite,
		deterministicRuleMatched,
		reasoningComplexity,
		riskLevel,
		expectedOutput: task.expectedOutput || 'text'
	}
}

module.exports = {
	profileTask
}

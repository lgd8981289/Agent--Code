export const principal = {
	tenantId: 'bluewhale',
	userId: 'user-1001'
}

export const now = new Date('2026-09-08T12:00:00+08:00')

export const scenarios = {
	direct: {
		question: '把“请尽快处理退款”改写得更礼貌。'
	},
	single: {
		question: '蓝鲸科技现在的退款金额超过多少元需要人工审核？'
	},
	multi: {
		question:
			'订单 A2026 的咖啡机退款金额是 3500 元，需要人工审核吗？准备材料时还要注意什么？'
	},
	clarify: {
		question: '我的咖啡机想申请退款，需要人工审核吗？'
	},
	unknown: {
		question: '蓝鲸科技的咖啡机是否提供终身免费上门保养？'
	}
}

/**
 * 模拟企业知识库返回的 Chunk。
 * 第二章已经实现过真实检索，本节只保留理解 Agentic RAG 所需的最小数据。
 */
export const knowledgeChunks = [
	{
		id: 'KB-REFUND-REVIEW-V3',
		tenantId: 'bluewhale',
		evidenceType: 'review_rule',
		title: '退款人工审核规则',
		content: '自 2026 年 9 月 1 日起，退款金额超过 2000 元时必须进入人工审核。',
		status: 'active',
		version: 3,
		effectiveAt: '2026-09-01T00:00:00+08:00',
		expiresAt: null
	},
	{
		id: 'KB-REFUND-MATERIAL-V2',
		tenantId: 'bluewhale',
		evidenceType: 'material_requirement',
		title: '咖啡机退款材料说明',
		content:
			'咖啡机退款需要提供订单号和清晰的机器序列号照片；商品存在质量问题时，还需要补充问题照片或视频。',
		status: 'active',
		version: 2,
		effectiveAt: '2026-08-20T00:00:00+08:00',
		expiresAt: null
	},
	{
		id: 'KB-REFUND-ARRIVAL-V1',
		tenantId: 'bluewhale',
		evidenceType: 'arrival_rule',
		title: '退款到账时间',
		content: '退款审核通过后，原路退回通常需要 1 至 3 个工作日。',
		status: 'active',
		version: 1,
		effectiveAt: '2026-07-01T00:00:00+08:00',
		expiresAt: null
	},
	{
		id: 'KB-MAINTENANCE-OLD',
		tenantId: 'bluewhale',
		evidenceType: 'maintenance_policy',
		title: '旧版咖啡机保养说明',
		content: '部分咖啡机曾参与免费上门保养活动。',
		status: 'superseded',
		version: 1,
		effectiveAt: '2025-01-01T00:00:00+08:00',
		expiresAt: null
	},
	{
		id: 'OTHER-TENANT-REFUND',
		tenantId: 'galaxy-retail',
		evidenceType: 'review_rule',
		title: '星河零售退款规则',
		content: '退款金额超过 5000 元时进入人工审核。',
		status: 'active',
		version: 4,
		effectiveAt: '2026-09-01T00:00:00+08:00',
		expiresAt: null
	}
]

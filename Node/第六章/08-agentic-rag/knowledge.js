import { knowledgeChunks } from './fixtures.js'

const queryByEvidenceType = {
	review_rule: '当前退款金额人工审核阈值和生效规则',
	material_requirement: '咖啡机申请退款需要提交哪些材料',
	arrival_rule: '退款审核通过以后多久到账',
	maintenance_policy: '咖啡机终身免费上门保养政策'
}

/** 根据当前缺少的证据类型，生成本轮更聚焦的检索问题。 */
export function buildSearchQuery(question, evidenceType) {
	return `${queryByEvidenceType[evidenceType]}。原始问题：${question}`
}

/**
 * 模拟第二章企业知识库的检索接口。
 * 真实项目可替换为 Milvus 混合检索与 Rerank，Graph 的其他部分不需要改变。
 */
export function searchKnowledge({ principal, evidenceType, query }) {
	if (!principal?.tenantId) throw new Error('缺少可信租户身份。')
	if (!queryByEvidenceType[evidenceType]) throw new Error('不支持的证据类型。')

	const candidates = knowledgeChunks
		.filter((chunk) =>
			chunk.tenantId === principal.tenantId &&
			chunk.evidenceType === evidenceType
		)
		.slice(0, 3)

	return { query, evidenceType, candidates }
}

function rejectReason(chunk, principal, requiredEvidence, now) {
	if (chunk.tenantId !== principal.tenantId) return '不属于当前租户'
	if (!requiredEvidence.includes(chunk.evidenceType)) return '不是当前问题需要的证据'
	if (chunk.status !== 'active') return '文档已经停用或被新版本替代'
	if (!Number.isFinite(Date.parse(chunk.effectiveAt)) || Date.parse(chunk.effectiveAt) > now.getTime()) {
		return '文档尚未生效或生效时间无效'
	}
	if (chunk.expiresAt !== null &&
		(!Number.isFinite(Date.parse(chunk.expiresAt)) || Date.parse(chunk.expiresAt) <= now.getTime())) {
		return '文档已经过期'
	}
	return null
}

/** 将检索候选分成可用证据和拒绝使用的内容，并找出仍然缺少的证据。 */
export function assessEvidence({ candidates, principal, requiredEvidence, now }) {
	const usable = []
	const rejected = []

	for (const chunk of candidates) {
		const reason = rejectReason(chunk, principal, requiredEvidence, now)
		if (reason) rejected.push({ id: chunk.id, reason })
		else if (!usable.some((item) => item.id === chunk.id)) usable.push(chunk)
	}

	const availableTypes = new Set(usable.map((chunk) => chunk.evidenceType))
	const missing = requiredEvidence.filter((type) => !availableTypes.has(type))

	return { usable, rejected, missing }
}

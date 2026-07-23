/**
 * 文件作用：
 * 提供企业售后业务逻辑，包括租户隔离查询、退款规则、幂等提交、
 * 批量审核长任务和审计记录。
 *
 * 章节定位：【本章重点】
 *
 * 建议阅读：
 * 重点理解 tenantId 如何限制数据范围、业务状态为什么独立于 MCP Server
 * 实例，以及退款幂等和长任务状态是如何实现的。
 */
import { randomUUID } from 'node:crypto'

import { logistics, orders, policies } from './data.js'

// ==================== 跨请求共享的业务状态 ====================

/**
 * 业务状态必须放在 MCP Server 实例之外。
 *
 * Streamable HTTP 会为请求创建新的 Server 实例；退款单、任务和审计记录
 * 属于业务状态，不能跟着协议连接一起销毁。
 */
const refundRequests = new Map()
const reviewJobs = new Map()
const auditLogs = []

function businessError(code, message) {
	return { ok: false, error: { code, message } }
}

function appendAudit(principal, action, targetId, detail = {}) {
	auditLogs.push({
		auditId: randomUUID(),
		tenantId: principal.tenantId,
		userId: principal.userId,
		action,
		targetId,
		detail,
		createdAt: new Date().toISOString()
	})
}

// ==================== 多租户只读查询 ====================

/**
 * 根据当前登录人的租户身份查询订单。
 *
 * tenantId 只能从 principal 中读取，
 * 调用方不能跨租户查询其他企业的订单。
 *
 * @param {object} principal 当前登录人的身份信息
 * @param {string} orderId 订单编号
 */
export function getOrder(principal, orderId) {
	// 同时匹配租户和订单编号，保证订单数据按租户隔离。
	const order = orders.find(
		(item) => item.tenantId === principal.tenantId && item.orderId === orderId
	)

	return order
		? { ok: true, order: { ...order } }
		: businessError('ORDER_NOT_FOUND', `没有找到订单 ${orderId}`)
}

export function getLogistics(principal, orderId) {
	const orderResult = getOrder(principal, orderId)
	if (!orderResult.ok) return orderResult

	const trace = logistics.find(
		(item) => item.tenantId === principal.tenantId && item.orderId === orderId
	)

	return trace
		? { ok: true, logistics: structuredClone(trace) }
		: businessError('LOGISTICS_NOT_FOUND', `订单 ${orderId} 暂无物流信息`)
}

export function getPolicy(principal, code) {
	const policy = policies.find(
		(item) => item.tenantId === principal.tenantId && item.code === code
	)

	return policy
		? { ok: true, policy: { ...policy } }
		: businessError('POLICY_NOT_FOUND', `没有找到规则 ${code}`)
}

export function searchPolicies(principal, query) {
	const words = query
		.toLowerCase()
		.split(/[\s，。？！、]+/)
		.filter(Boolean)

	const results = policies
		.filter((item) => item.tenantId === principal.tenantId)
		.map((item) => ({
			...item,
			score: words.filter((word) =>
				`${item.title}\n${item.content}`.toLowerCase().includes(word)
			).length
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)

	return { ok: true, results }
}

// ==================== 退款规则与幂等提交 ====================

/** 退款资格由确定性业务规则判断，而不是交给模型猜。 */
export function previewRefund(principal, orderId, reason) {
	const orderResult = getOrder(principal, orderId)
	if (!orderResult.ok) return orderResult

	const { order } = orderResult
	let eligible = true
	let manualReview = false
	let conclusion = '订单满足自动退款条件。'

	if (order.status !== 'delivered') {
		eligible = false
		conclusion = '订单尚未签收，不能按已签收退款流程处理。'
	} else if (order.category === 'fresh') {
		eligible = false
		conclusion = '生鲜商品不支持无理由退款。'
	} else if (order.signedDays > 7) {
		eligible = false
		conclusion = `订单已签收 ${order.signedDays} 天，超过 7 天退款期限。`
	} else if (order.amount > 2000) {
		manualReview = true
		conclusion = `退款金额 ${order.amount} 元，超过 2000 元，需要人工审核。`
	}

	return {
		ok: true,
		preview: {
			orderId,
			productName: order.productName,
			refundAmount: order.amount,
			reason,
			eligible,
			manualReview,
			conclusion
		}
	}
}

/**
 * 创建退款申请，并用 tenantId + idempotencyKey 防止重复提交。
 */
export function submitRefund(principal, { orderId, reason, idempotencyKey }) {
	const idempotencyId = `${principal.tenantId}:${idempotencyKey}`
	const existing = refundRequests.get(idempotencyId)

	if (existing) {
		return { ok: true, duplicated: true, refundRequest: { ...existing } }
	}

	const previewResult = previewRefund(principal, orderId, reason)
	if (!previewResult.ok) return previewResult
	if (!previewResult.preview.eligible) {
		return businessError(
			'REFUND_NOT_ELIGIBLE',
			previewResult.preview.conclusion
		)
	}

	const refundRequest = {
		refundId: `REF-${randomUUID().slice(0, 8).toUpperCase()}`,
		tenantId: principal.tenantId,
		orderId,
		amount: previewResult.preview.refundAmount,
		reason,
		status: previewResult.preview.manualReview ? 'manual_review' : 'approved',
		createdBy: principal.userId,
		createdAt: new Date().toISOString()
	}

	refundRequests.set(idempotencyId, refundRequest)
	appendAudit(principal, 'submit_refund', refundRequest.refundId, {
		orderId,
		idempotencyKey
	})

	return { ok: true, duplicated: false, refundRequest: { ...refundRequest } }
}

export function getRefundByIdempotencyKey(principal, idempotencyKey) {
	const refundRequest = refundRequests.get(
		`${principal.tenantId}:${idempotencyKey}`
	)

	return refundRequest ? { ...refundRequest } : null
}

// ==================== 批量审核长任务 ====================

export function startBatchReview(principal, orderIds) {
	if (principal.role !== 'finance') {
		return businessError('FORBIDDEN', '只有财务角色可以启动批量退款审核')
	}

	const invalidOrderId = orderIds.find(
		(orderId) => !getOrder(principal, orderId).ok
	)
	if (invalidOrderId)
		return businessError('ORDER_NOT_FOUND', `没有找到订单 ${invalidOrderId}`)

	const job = {
		jobId: `JOB-${randomUUID().slice(0, 8).toUpperCase()}`,
		tenantId: principal.tenantId,
		orderIds: [...orderIds],
		status: 'working',
		createdBy: principal.userId,
		createdAt: Date.now(),
		cancelledAt: null
	}

	reviewJobs.set(job.jobId, job)
	appendAudit(principal, 'start_batch_review', job.jobId, { orderIds })

	return { ok: true, job: getJobSnapshot(principal, job.jobId).job }
}

/**
 * 通过已运行时间模拟后台任务进度。
 * 真实项目可替换为 BullMQ、RabbitMQ 或企业任务平台。
 */
export function getJobSnapshot(principal, jobId) {
	const job = reviewJobs.get(jobId)
	if (!job || job.tenantId !== principal.tenantId) {
		return businessError('JOB_NOT_FOUND', `没有找到任务 ${jobId}`)
	}

	if (job.cancelledAt) {
		return {
			ok: true,
			job: { ...job, status: 'cancelled', progress: 0, message: '任务已取消' }
		}
	}

	const elapsed = Date.now() - job.createdAt
	if (elapsed < 800) {
		return {
			ok: true,
			job: { ...job, status: 'working', progress: 25, message: '正在读取订单' }
		}
	}

	if (elapsed < 1600) {
		return {
			ok: true,
			job: {
				...job,
				status: 'working',
				progress: 70,
				message: '正在执行退款规则'
			}
		}
	}

	const details = job.orderIds.map((orderId) => {
		const result = previewRefund(principal, orderId, '批量审核')
		return {
			orderId,
			eligible: result.preview?.eligible ?? false,
			manualReview: result.preview?.manualReview ?? false,
			conclusion: result.preview?.conclusion ?? result.error?.message
		}
	})

	return {
		ok: true,
		job: {
			...job,
			status: 'completed',
			progress: 100,
			message: '批量审核完成',
			result: {
				total: details.length,
				autoApproved: details.filter(
					(item) => item.eligible && !item.manualReview
				).length,
				manualReview: details.filter((item) => item.manualReview).length,
				rejected: details.filter((item) => !item.eligible).length,
				details
			}
		}
	}
}

export function cancelBatchReview(principal, jobId) {
	if (principal.role !== 'finance') {
		return businessError('FORBIDDEN', '只有财务角色可以取消批量退款审核')
	}

	const snapshot = getJobSnapshot(principal, jobId)
	if (!snapshot.ok) return snapshot
	if (snapshot.job.status === 'completed') {
		return businessError('JOB_ALREADY_COMPLETED', '任务已经完成，无法取消')
	}

	const job = reviewJobs.get(jobId)
	job.cancelledAt = Date.now()
	appendAudit(principal, 'cancel_batch_review', jobId)

	return getJobSnapshot(principal, jobId)
}

export function getAuditLogs(principal) {
	return auditLogs.filter((item) => item.tenantId === principal.tenantId)
}

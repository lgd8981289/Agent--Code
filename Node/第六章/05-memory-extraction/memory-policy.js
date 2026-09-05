const SENSITIVE_PATTERNS = [
	/\b\d{17}[\dXx]\b/,
	/\b1[3-9]\d{9}\b/,
	/\b\d{16,19}\b/
]

function reject(code, reason) {
	return { accepted: false, code, reason }
}

/**
 * 审核一条候选记忆是否允许写入。
 * 模型负责提取，最终写入权限仍然掌握在确定性代码中。
 */
export function reviewMemoryCandidate(candidate, messages, options) {
	if (!options.memoryEnabled) {
		return reject('MEMORY_DISABLED', '用户没有开启长期记忆。')
	}

	const source = messages.find(
		(message) => message.id === candidate.sourceMessageId
	)

	if (!source || source.role !== 'user') {
		return reject(
			'UNTRUSTED_SOURCE',
			'候选不是来自当前用户的原始消息。'
		)
	}

	if (!source.content.includes(candidate.evidenceQuote)) {
		return reject(
			'MISSING_EVIDENCE',
			'来源消息中找不到模型给出的原文证据。'
		)
	}

	if (candidate.duration !== 'long_term') {
		return reject(
			'NOT_LONG_TERM',
			'这条信息只适用于当前任务，或者真实性尚未确认。'
		)
	}

	const textToCheck = `${candidate.content}\n${candidate.evidenceQuote}`
	if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(textToCheck))) {
		return reject(
			'SENSITIVE_DATA',
			'候选包含课程策略禁止自动保存的敏感信息。'
		)
	}

	return {
		accepted: true,
		code: 'ACCEPTED',
		reason: '来源、保存范围和敏感信息检查均已通过。'
	}
}

/** 批量审核模型提出的候选记忆。 */
export function reviewMemoryCandidates(candidates, messages, options) {
	return candidates.map((candidate) => ({
		candidate,
		decision: reviewMemoryCandidate(candidate, messages, options)
	}))
}

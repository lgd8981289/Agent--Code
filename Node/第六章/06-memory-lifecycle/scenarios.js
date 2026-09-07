export const principal = { tenantId: 'bluewhale', userId: 'user-1001' }

/** 固定候选模拟上一节提取和审核后的输入；来源信息由应用绑定。 */
export const candidates = {
	initial: {
		key: 'preferred_runtime',
		value: 'Node.js',
		scope: 'long_term',
		expiresAt: null,
		source: { threadId: 'thread-a', messageId: 'msg-1', observedAt: '2026-09-01T09:00:00+08:00' }
	},
	repeat: {
		key: 'preferred_runtime',
		value: 'nodejs',
		scope: 'long_term',
		expiresAt: null,
		source: { threadId: 'thread-b', messageId: 'msg-2', observedAt: '2026-09-02T09:00:00+08:00' }
	},
	temporary: {
		key: 'preferred_runtime',
		value: 'Python',
		scope: 'current_thread',
		expiresAt: null,
		source: { threadId: 'thread-b', messageId: 'msg-3', observedAt: '2026-09-02T10:00:00+08:00' }
	},
	correction: {
		key: 'preferred_runtime',
		value: 'Python',
		scope: 'long_term',
		expiresAt: null,
		source: { threadId: 'thread-c', messageId: 'msg-4', observedAt: '2026-09-03T09:00:00+08:00' }
	},
	language: {
		key: 'preferred_language',
		value: 'TypeScript',
		scope: 'long_term',
		expiresAt: null,
		source: { threadId: 'thread-a', messageId: 'msg-1', observedAt: '2026-09-01T09:00:00+08:00' }
	},
	contact: {
		key: 'contact_window',
		value: '出差期间只通过邮件联系',
		scope: 'long_term',
		expiresAt: '2026-09-08T00:00:00+08:00',
		source: { threadId: 'thread-c', messageId: 'msg-5', observedAt: '2026-09-06T09:00:00+08:00' }
	}
}

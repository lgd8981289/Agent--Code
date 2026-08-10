import { describe, expect, it } from 'vitest'
import { isTaskOverdue } from '../src/tasks/overdue'
import type { TaskRecord } from '../src/tasks/task.types'

const task: TaskRecord = {
	id: 'T-2001',
	title: '验证截止时间边界',
	status: 'todo',
	priority: 'high',
	dueAt: '2026-08-03T10:00:00.000Z'
}

describe('isTaskOverdue', () => {
	it('does not mark a completed task overdue', () => {
		expect(
			isTaskOverdue(
				{ ...task, status: 'done' },
				new Date('2026-08-03T10:00:01.000Z')
			)
		).toBe(false)
	})

	it('does not mark a task overdue at the exact due time', () => {
		expect(isTaskOverdue(task, new Date('2026-08-03T10:00:00.000Z'))).toBe(false)
	})

	it('marks a task overdue after the due time', () => {
		expect(isTaskOverdue(task, new Date('2026-08-03T10:00:01.000Z'))).toBe(true)
	})
})

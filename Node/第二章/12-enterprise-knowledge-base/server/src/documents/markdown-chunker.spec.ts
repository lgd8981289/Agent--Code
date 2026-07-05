import { describe, expect, it } from 'vitest'
import { chunkMarkdown, normalizeMarkdown } from './markdown-chunker.js'

describe('Markdown chunker', () => {
	it('按照标题和段落分块，并保留标题路径', () => {
		const chunks = chunkMarkdown(
			`# 售后手册\n\n## 退款规则\n\n${'超过 3000 元需要人工审核，审核人员需要核对订单状态、签收时间、商品类型和退款原因。'.repeat(5)}\n\n普通商品签收后 7 天内可以申请退款。`,
			120,
			10
		)

		expect(chunks.length).toBeGreaterThan(1)
		expect(chunks[0].content).toContain('售后手册 / 退款规则')
		expect(chunks.map((item) => item.index)).toEqual(
			chunks.map((_item, index) => index)
		)
	})

	it('统一换行后再计算文档内容', () => {
		expect(normalizeMarkdown('a\r\n\r\nb\r\n')).toBe('a\n\nb')
	})

	it('空文档不会生成 Chunk', () => {
		expect(chunkMarkdown('   ')).toEqual([])
	})
})

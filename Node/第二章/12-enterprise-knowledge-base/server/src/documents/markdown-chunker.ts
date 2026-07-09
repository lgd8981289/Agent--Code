import type { Root, RootContent } from 'mdast'
import { toString } from 'mdast-util-to-string'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { TextChunk } from './document.types.js'

interface Section {
	heading: string
	paragraphs: string[]
}

/** 统一不同操作系统的换行符，保证 checksum 和分块结果稳定。 */
export function normalizeMarkdown(markdown: string): string {
	return markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
}

/**
 * 把 Markdown AST 按标题层级整理成多个文本段落区块。
 * 标题路径会保留到 Chunk 中，为正文补充必要的章节语义。
 */
function parseSections(markdown: string): Section[] {
	const tree = unified().use(remarkParse).parse(markdown) as Root
	const sections: Section[] = []
	const headingPath: string[] = []
	let current: Section = { heading: '', paragraphs: [] }

	const flush = () => {
		if (current.paragraphs.length > 0) sections.push(current)
	}

	for (const node of tree.children) {
		if (node.type === 'heading') {
			flush()
			const depth = node.depth
			headingPath.splice(depth - 1)
			headingPath[depth - 1] = toString(node).trim()
			current = {
				heading: headingPath.filter(Boolean).join(' / '),
				paragraphs: []
			}
			continue
		}

		const text = nodeToText(node)
		if (text) current.paragraphs.push(text)
	}

	flush()
	return sections
}

/** 把不同类型的 Markdown 节点转换成适合检索的纯文本。 */
function nodeToText(node: RootContent): string {
	if (node.type === 'code') {
		return node.value.trim()
	}

	return toString(node).replace(/\s+/gu, ' ').trim()
}

/**
 * 切分超过 Chunk 上限的长文本，并保留少量重叠内容。
 */
function splitLongText(text: string, maxLength: number, overlap: number) {
	const parts: string[] = []
	const step = Math.max(1, maxLength - overlap)

	for (let start = 0; start < text.length; start += step) {
		parts.push(text.slice(start, start + maxLength))
		if (start + maxLength >= text.length) break
	}

	return parts
}

/**
 * 按标题和段落生成最终 Chunk。
 *
 * @param markdown 原始 Markdown 文本。
 * @param maxLength 单个 Chunk 的目标字符上限。
 * @param overlap 长文本切分时保留的重叠字符数。
 */
export function chunkMarkdown(
	markdown: string,
	maxLength = 700,
	overlap = 80
): TextChunk[] {
	const normalized = normalizeMarkdown(markdown)
	if (!normalized) return []

	const chunks: string[] = []

	for (const section of parseSections(normalized)) {
		// 标题会重复写入当前章节的每个 Chunk，避免正文离开标题后失去语义。
		const prefix = section.heading ? `${section.heading}\n\n` : ''
		const bodyLimit = Math.max(100, maxLength - prefix.length)
		let current = ''

		const flush = () => {
			if (!current) return
			chunks.push(`${prefix}${current}`.trim())
			current = ''
		}

		for (const paragraph of section.paragraphs) {
			if (paragraph.length > bodyLimit) {
				flush()
				for (const part of splitLongText(paragraph, bodyLimit, overlap)) {
					chunks.push(`${prefix}${part}`.trim())
				}
				continue
			}

			const next = current ? `${current}\n\n${paragraph}` : paragraph
			if (next.length > bodyLimit) flush()
			current = current ? `${current}\n\n${paragraph}` : paragraph
		}

		flush()
	}

	return chunks.map((content, index) => ({ index, content }))
}

// 模拟一个很小的词表
// 真实大模型的词表会非常大，可能包含几万到几十万个 Token
const vocabulary = [
	'Agent',
	'ic',
	'退款',
	'金额',
	'超过',
	'人工',
	'审核',
	'开发',
	' ',
	'。'
]

// 对词表进行排序：长度越长的 Token 越靠前
// 这样在匹配时，会优先匹配更长的内容
//
// 例如：
// 如果词表里同时有 "Agent" 和 "A"
// 那么应该优先匹配 "Agent"，而不是先匹配 "A"
const sortedVocabulary = [...vocabulary].sort(
	(first, second) => second.length - first.length
)

/**
 * 将一段文本切分成 Token
 *
 * 这里模拟的是一种简化版 Tokenizer：
 * 从左到右扫描文本，每次都在词表中寻找一个可以匹配当前位置的最长 Token。
 */
function tokenize(text) {
	// 用来保存最终切分出来的 Token
	const tokens = []

	// rest 表示当前还没有被切分的剩余文本
	let rest = text

	// 只要还有剩余文本，就继续切分
	while (rest.length > 0) {
		// 从排序后的词表中查找第一个能够匹配当前开头的 Token
		// 因为 sortedVocabulary 已经按长度从长到短排序，
		// 所以 find 找到的第一个结果，就是当前能匹配到的最长 Token
		const matchedToken = sortedVocabulary.find((token) =>
			rest.startsWith(token)
		)

		// 如果在词表中找到了匹配的 Token
		if (matchedToken) {
			// 把匹配到的 Token 放入结果数组
			tokens.push(matchedToken)

			// 从剩余文本中移除已经匹配过的部分
			// 然后继续处理后面的内容
			rest = rest.slice(matchedToken.length)
			continue
		}

		// 如果词表中没有任何 Token 能匹配当前开头，
		// 就把当前第一个字符当作未知 Token 处理
		//
		// 这里使用 [...rest] 是为了更安全地处理 Unicode 字符，
		// 避免某些特殊字符被错误切分
		const [unknownCharacter] = [...rest]

		// 将未知字符加入 Token 列表
		tokens.push(unknownCharacter)

		// 从剩余文本中移除这个未知字符
		rest = rest.slice(unknownCharacter.length)
	}

	// 返回最终的 Token 切分结果
	return tokens
}

// 准备几组测试文本
const samples = ['Agent 开发', 'Agentic 开发', '退款金额超过，需要人工审核。']

// 依次对每段文本进行 Token 切分
for (const sample of samples) {
	// 调用 tokenize 方法，把原始文本切成 Token
	const tokens = tokenize(sample)

	// 打印原始文本
	console.log(`\n原始内容：${sample}`)

	// 打印 Tokenizer 的切分结果
	console.log('切分结果：', tokens)

	// 打印 Token 数量
	// 这可以帮助理解：同一段文字经过不同词表切分后，Token 数可能不同
	console.log(`Token 数量：${tokens.length}`)
}

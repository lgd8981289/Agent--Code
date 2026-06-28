// 模拟已经切好的 Token
const tokens = [
	'订单',
	'A1024',
	'退款金额',
	'3000',
	'元',
	'超过',
	'2000',
	'元',
	'需要',
	'人工审核'
]

// 模拟每个 Token 对应的向量
// 真实模型里的向量是训练出来的，这里是为了演示手动写的
const features = {
	订单: [0, 0, 0, 0, 1],
	A1024: [0, 0, 0, 0, 1],
	退款金额: [1, 0, 0, 0, 0],
	3000: [1, 0, 0, 0, 0],
	元: [0.4, 0.4, 0, 0, 0],
	超过: [0, 0, 1, 0, 0],
	2000: [0, 1, 0, 0, 0],
	需要: [0, 0, 1, 1, 0],
	人工审核: [0.5, 0.5, 1, 1, 0]
}

// 模拟一个 Attention Head
// 这个 Head 更关注“金额、阈值、超过、审核”这些信息
const head = {
	name: '金额审核关系头',
	queryWeights: [1, 1, 1, 1, 0],
	keyWeights: [1, 1, 1, 0.8, 0],
	valueWeights: [1, 1, 1, 1, 0]
}

// 简化版投影：用权重调整向量
function project(vector, weights) {
	return vector.map((value, index) => value * weights[index])
}

// 计算两个向量的相似度
function dot(a, b) {
	return a.reduce((sum, value, index) => sum + value * b[index], 0)
}

// 把分数转换成注意力权重
function softmax(scores) {
	const max = Math.max(...scores)
	const exps = scores.map((score) => Math.exp(score - max))
	const total = exps.reduce((sum, value) => sum + value, 0)

	return exps.map((value) => value / total)
}

// 按照注意力权重，把多个 Value 汇总成一个新向量
function weightedSum(values, weights) {
	const result = Array.from({ length: values[0].length }, () => 0)

	for (let i = 0; i < values.length; i++) {
		for (let j = 0; j < values[i].length; j++) {
			result[j] += values[i][j] * weights[i]
		}
	}

	return result
}

// 对指定 Token 执行一次 Attention 计算
function runAttention(targetToken) {
	const targetIndex = tokens.indexOf(targetToken)

	// 只看当前 Token 以及它前面的内容
	const visibleTokens = tokens.slice(0, targetIndex + 1)

	// 当前 Token 生成 Query
	const query = project(features[targetToken], head.queryWeights)

	// 前文 Token 分别生成 Key 和 Value
	const keys = visibleTokens.map((token) =>
		project(features[token], head.keyWeights)
	)
	const values = visibleTokens.map((token) =>
		project(features[token], head.valueWeights)
	)

	// 计算当前 Token 和前文每个 Token 的相关性
	const scores = keys.map((key) => dot(query, key) / Math.sqrt(query.length))

	// 将相关性分数转换成注意力权重
	const weights = softmax(scores)

	// 根据注意力权重汇总 Value，得到新的表示
	const newRepresentation = weightedSum(values, weights)

	// 整理注意力权重，方便查看
	const attentionList = visibleTokens
		.map((token, index) => ({ token, weight: weights[index] }))
		.sort((a, b) => b.weight - a.weight)

	return { query, attentionList, newRepresentation }
}

// 观察“人工审核”这个 Token 会关注哪些前文信息
const result = runAttention('人工审核')

console.log(`Attention Head：${head.name}`)
console.log('目标 Token：人工审核')
console.log(
	'Query：',
	result.query.map((value) => value.toFixed(2))
)

console.log('\n注意力权重 Top 6：')
for (const item of result.attentionList.slice(0, 6)) {
	console.log(`${item.token}: ${(item.weight * 100).toFixed(2)}%`)
}

console.log('\n加权汇总 Value 后，得到的新表示：')
console.log(result.newRepresentation.map((value) => value.toFixed(3)))

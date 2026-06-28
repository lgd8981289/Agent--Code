// Node.js 版本：模拟大模型逐个生成 Token 的过程。

// candidateMap 用来模拟：在不同上下文下，模型可能生成的候选 Token 及其 Logit 分数
// Map 的 key 表示“当前上下文”
// Map 的 value 表示“候选 Token 列表”
// 每个候选项的格式是：[候选 Token, Logit 分数]
const candidateMap = new Map([
	[
		'周末我准备',
		[
			['学习', 3.2],
			['休息', 2.6],
			['出门', 2.1]
		]
	],
	[
		'周末我准备学习',
		[
			[' Agent', 3.8],
			[' Node.js', 2.7],
			['英语', 1.6]
		]
	],
	[
		'周末我准备学习 Agent',
		[
			['。', 3.1],
			['开发', 2.4],
			['相关知识', 1.8]
		]
	],
	[
		'周末我准备学习 Agent。',
		[
			['<EOS>', 4.2],
			['然后', 1.1]
		]
	]
])

/**
 * 将候选 Token 的 Logit 分数转换成概率分布
 *
 * Logit 是模型输出的原始分数，不能直接当作概率使用。
 * softmax 的作用是：
 * 1. 把所有候选 Token 的分数转换成正数
 * 2. 再归一化，让所有候选 Token 的概率加起来等于 1
 */
function softmax(candidates) {
	// 找出最大的 Logit
	// 这里用它做数值稳定处理，避免 Math.exp(logit) 计算时数值过大
	const maxLogit = Math.max(...candidates.map(([, logit]) => logit))

	// 对每个 Logit 做指数运算
	// logit - maxLogit 不会改变最终 softmax 的概率比例，
	// 但可以避免指数运算时出现数值溢出
	const items = candidates.map(([token, logit]) => [
		token,
		Math.exp(logit - maxLogit)
	])

	// 计算所有指数值的总和
	// 后面需要用每一项除以总和，得到归一化概率
	const total = items.reduce((sum, [, value]) => sum + value, 0)

	// 返回每个候选 Token 对应的概率
	return items.map(([token, value]) => [token, value / total])
}

/**
 * 从概率列表中选择概率最高的 Token
 *
 * 这里采用的是“贪心选择”：
 * 每一步都直接选择当前概率最高的 Token。
 *
 * 真实大模型生成时，也可以使用 temperature、top-k、top-p 等采样策略，
 * 不一定每次都选择概率最高的 Token。
 */
function chooseHighest(probabilities) {
	return probabilities.reduce((best, current) =>
		current[1] > best[1] ? current : best
	)
}

// 初始上下文
// 可以理解为用户已经输入给模型的内容
let context = '周末我准备'

// 最多生成 10 步，防止生成过程无限循环
for (let step = 1; step <= 10; step += 1) {
	// 根据当前上下文，查找对应的候选 Token 列表
	const candidates = candidateMap.get(context)

	// 如果当前上下文没有对应的候选内容，
	// 说明模拟数据中已经没有后续可生成的内容了
	if (!candidates) {
		console.log('没有更多候选内容，生成结束。')
		break
	}

	// 把候选 Token 的 Logit 分数转换成概率
	const probabilities = softmax(candidates)

	// 从概率分布中选择概率最高的 Token
	const [selectedToken] = chooseHighest(probabilities)

	// 打印当前生成步骤
	console.log(`\n第 ${step} 步`)

	// 打印当前上下文
	console.log(`当前上下文：${context}`)

	// 以表格形式打印每个候选 Token 的概率
	console.table(
		probabilities.map(([token, probability]) => ({
			候选内容: token,
			概率: `${(probability * 100).toFixed(2)}%`
		}))
	)

	// 打印本轮最终选择的 Token
	console.log(`本次选择：${selectedToken}`)

	// <EOS> 表示 End Of Sequence，也就是“结束标记”
	// 如果模型生成了 <EOS>，说明本次生成应该停止
	if (selectedToken === '<EOS>') {
		console.log('模型生成了结束标记，生成结束。')
		break
	}

	// 将本次选择的 Token 拼接到上下文后面
	// 下一轮生成时，模型会基于更新后的上下文继续预测下一个 Token
	context += selectedToken
}

// 打印最终生成出来的完整内容
console.log(`\n最终内容：${context}`)

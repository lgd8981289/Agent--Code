import { now, principal, scenarios } from './fixtures.js'
import { createModelServices } from './models.js'
import { createAgenticRagGraph } from './workflow.js'

function printResult(scenarioName, question, result) {
	console.log(`\n========== 场景：${scenarioName} ==========`)
	console.log(`\n用户问题：${question}`)
	console.log('\n执行轨迹：')
	for (const [index, line] of result.trace.entries()) {
		console.log(`${index + 1}. ${line}`)
	}
	console.log(`\n最终状态：${result.outcome}`)
	console.log(`检索次数：${result.searchAttempts}`)
	console.log(`\n最终回答：\n${result.finalAnswer}`)

	if (result.sourceIds.length > 0) {
		console.log('\n真实引用来源：')
		for (const sourceId of result.sourceIds) {
			const chunk = result.usableEvidence.find((item) => item.id === sourceId)
			console.log(`\n[${chunk.id}] ${chunk.title}\n${chunk.content}`)
		}
	}
}

/**
 * Agentic RAG 示例入口。
 *
 * 根据命令行参数选择测试场景，
 * 创建 Agentic RAG Graph 并执行当前问题，
 * 最后输出 Graph 的完整执行结果。
 */
async function main() {
	// 从命令行读取运行场景，例如：
	// node index.js multi
	// 未指定时默认使用 multi 场景
	const scenarioName = process.argv[2] ?? 'multi'

	// 根据场景名称获取对应的测试问题和配置
	const scenario = scenarios[scenarioName]

	// 防止传入不存在的场景，并提示当前支持的场景名称
	if (!scenario) {
		throw new Error(
			`未知场景 ${scenarioName}，可选值：${Object.keys(scenarios).join('、')}。`
		)
	}

	/**
	 * 创建 Agentic RAG Graph。
	 *
	 * services：Graph 中各节点需要使用的模型服务
	 * principal：当前用户/租户等身份上下文
	 * now：当前时间，用于需要时间判断的业务逻辑
	 * maxSearches：限制最多执行 3 次检索，避免 Agent 无限搜索
	 */
	const graph = createAgenticRagGraph({
		services: createModelServices(),
		principal,
		now,
		maxSearches: 3
	})

	// 以当前场景的问题作为初始 State 输入，启动整个 Graph。
	// Graph 会根据内部路由完成检索、判断、补充搜索和回答生成等流程
	const result = await graph.invoke({
		question: scenario.question
	})

	// 输出场景名称、原始问题以及 Graph 最终执行结果，便于观察不同场景的运行路径
	printResult(scenarioName, scenario.question, result)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

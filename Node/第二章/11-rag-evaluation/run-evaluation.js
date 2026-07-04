import { evaluationCases } from './evaluation-cases.js'
import {
	diagnose,
	evaluateFaithfulness,
	evaluateRetrieval,
	mean
} from './rag-evaluator.js'

const TOP_K = 3
const mode = process.argv[2] ?? 'retrieval'

if (!['retrieval', 'full'].includes(mode)) {
	throw new Error('运行模式只能是 retrieval 或 full。')
}

const results = []

for (const evaluationCase of evaluationCases) {
	const retrieval = evaluateRetrieval(evaluationCase, TOP_K)
	const faithfulnessResult =
		mode === 'full'
			? await evaluateFaithfulness(evaluationCase)
			: null

	const result = {
		id: evaluationCase.id,
		name: evaluationCase.name,
		question: evaluationCase.question,
		...retrieval,
		faithfulness: faithfulnessResult?.score ?? null,
		claims: faithfulnessResult?.claims ?? [],
		diagnosis: diagnose({
			...retrieval,
			faithfulness: faithfulnessResult?.score ?? null
		})
	}

	results.push(result)
}

console.log(`评估模式：${mode === 'full' ? '完整评估' : '仅检索指标'}`)
console.log(`TopK：${TOP_K}`)

for (const result of results) {
	console.log(`\n================ ${result.name} ================`)
	console.log(`问题：${result.question}`)
	console.log(
		`Recall@${TOP_K}：${
			result.recall === null ? 'N/A' : result.recall.toFixed(6)
		}`
	)
	console.log(`RR@${TOP_K}：${result.reciprocalRank.toFixed(6)}`)

	if (result.faithfulness !== null) {
		console.log(`Faithfulness：${result.faithfulness.toFixed(6)}`)
		console.log('Claim 判断：')

		for (const claim of result.claims) {
			console.log(
				`- [${claim.supported ? '支持' : '不支持'}] ${claim.claim}`
			)
		}
	}

	console.log(`定位建议：${result.diagnosis}`)
}

const validRecallValues = results
	.map((result) => result.recall)
	.filter((value) => value !== null)
const meanRecall = mean(validRecallValues)
const mrr = mean(results.map((result) => result.reciprocalRank))

console.log('\n================ 整体指标 ================')
console.log(`Mean Recall@${TOP_K}：${meanRecall.toFixed(6)}`)
console.log(`MRR@${TOP_K}：${mrr.toFixed(6)}`)

if (mode === 'full') {
	const meanFaithfulness = mean(
		results
			.map((result) => result.faithfulness)
			.filter((value) => value !== null)
	)
	console.log(`Mean Faithfulness：${meanFaithfulness.toFixed(6)}`)
}

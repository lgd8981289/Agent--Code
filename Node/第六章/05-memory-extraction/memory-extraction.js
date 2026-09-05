import { InMemoryStore } from '@langchain/langgraph'
import { conversation, principal, replayCandidates } from './conversation.js'
import {
	createMemoryExtractor,
	extractMemoryCandidates
} from './memory-extractor.js'
import { reviewMemoryCandidates } from './memory-policy.js'
import { saveAcceptedMemories } from './memory-store.js'

function printCandidates(candidates) {
	console.log('\n========== 模型提出的候选记忆 ==========')
	console.table(
		candidates.map((candidate) => ({
			内容: candidate.content,
			范围: candidate.duration,
			来源: candidate.sourceMessageId
		}))
	)
}

function printReviews(reviews) {
	console.log('\n========== 策略层审核结果 ==========')
	console.table(
		reviews.map(({ candidate, decision }) => ({
			候选: candidate.content,
			是否写入: decision.accepted ? '是' : '否',
			结果码: decision.code,
			原因: decision.reason
		}))
	)
}

/**
 * 主流程：
 * 1. 从对话中提取长期记忆候选；
 * 2. 根据用户授权和记忆策略审核候选；
 * 3. 将审核通过的记忆写入 Store；
 * 4. 输出最终持久化结果。
 */
async function main() {
	/**
	 * 读取命令行参数，决定本次实验的运行模式。
	 *
	 * - replay：使用预先准备好的候选数据，方便稳定复现实验
	 * - ai：调用大模型，从真实对话中提取记忆候选
	 * - no-consent：模拟用户未授权长期记忆的场景
	 */
	const mode = process.argv[2] ?? 'replay'

	/**
	 * 是否允许写入长期记忆。
	 *
	 * no-consent 模式下关闭记忆功能，
	 * 用于验证“即使提取出了候选，也不能直接写入 Store”。
	 */
	const memoryEnabled = mode !== 'no-consent'

	// 创建内存版 Store，模拟 Agent 的长期记忆存储。
	const store = new InMemoryStore()

	/**
	 * 获取待审核的记忆候选。这里分成了两个不同的模式
	 *
	 * ai 模式：
	 *   调用 Memory Extractor，让大模型从 conversation 中识别值得长期保存的信息。
	 *
	 * 其他模式：
	 *   直接使用预先准备好的 replayCandidates，
	 *   避免模型输出波动，方便观察后续审核与写入逻辑。
	 */
	const candidates =
		mode === 'ai'
			? await extractMemoryCandidates(createMemoryExtractor(), conversation)
			: replayCandidates

	// 输出模型提取或预设得到的原始记忆候选。
	printCandidates(candidates)

	/**
	 * 对候选记忆进行策略审核。
	 *
	 * 审核阶段并不会直接写入 Store，
	 * 而是结合候选内容、原始对话以及用户是否开启记忆功能，
	 * 判断每条候选最终应该接受还是拒绝。
	 */
	const reviews = reviewMemoryCandidates(candidates, conversation, {
		memoryEnabled
	})

	// 输出每条候选的审核结果及拒绝/接受原因。
	printReviews(reviews)

	/**
	 * 只将审核通过的记忆真正写入 Store。
	 *
	 * principal 用于确定记忆所属的用户/主体，
	 * 防止不同用户之间的长期记忆发生串扰。
	 */
	const saved = await saveAcceptedMemories(store, principal, reviews)

	// 查看本轮流程最终成功持久化到 Store 中的记忆。
	console.log('\n========== Store 最终写入结果 ==========')
	console.dir(saved, { depth: null })
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

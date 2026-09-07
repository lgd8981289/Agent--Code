import { InMemoryStore } from '@langchain/langgraph'
import {
	principal,
	now,
	question,
	threadState,
	currentFacts
} from './fixtures.js'
import { ZhipuEmbeddings, createAnswerModel } from './models.js'
import {
	seedStore,
	loadAnswerPreferences,
	recallEvents,
	getCurrentDecision,
	buildModelInput
} from './recall.js'

/**
 * 从本次用户提问出发，完整演示一次“记忆召回 → Context 组装 → 模型调用”的过程。
 *
 * demo 模式：
 * - 执行真实向量召回
 * - 打印召回决策、最终记忆和模型输入
 * - 不真正调用大模型
 *
 * answer 模式：
 * - 在 demo 模式基础上
 * - 继续调用 DeepSeek 生成最终回答
 */
async function main() {
	// 从命令行读取运行模式，未指定时默认只演示召回过程。
	const mode = process.argv[2] ?? 'demo'

	// 只允许 demo 和 answer 两种模式，避免传入未定义的执行路径。
	if (!['demo', 'answer'].includes(mode)) {
		throw new Error('可用模式：demo、answer。')
	}

	/**
	 * 创建 Embedding 模型。
	 *
	 * Store 会使用它把记忆 content 转换成向量，
	 * 后续根据用户问题进行语义相似度检索。
	 */
	const embeddings = new ZhipuEmbeddings()

	/**
	 * 创建支持向量检索的内存 Store。
	 *
	 * index：
	 * - embeddings：负责生成向量
	 * - dims：Embedding 向量维度
	 * - fields：指定哪些字段参与向量索引
	 *
	 * 这里仅对 memory.value.content 建立语义索引。
	 */
	const store = new InMemoryStore({
		index: {
			embeddings,
			dims: embeddings.dimensions,
			fields: ['content']
		}
	})

	// 写入本案例预设的用户偏好、历史事件等测试记忆。
	await seedStore(store, principal)

	console.log('\n========== 本次问题 ==========\n' + question)

	/**
	 * 精确读取用户的回答偏好。
	 *
	 * 这类稳定配置已经有明确 Key，
	 * 不需要通过向量相似度搜索，直接按 Namespace + Key 获取即可。
	 */
	const preferences = await loadAnswerPreferences(store, principal, now)

	console.log('\n========== 精确读取的回答偏好 ==========')
	console.dir(preferences, { depth: null })

	/**
	 * 根据当前问题召回相关历史事件。
	 *
	 * recallEvents 内部不仅进行向量检索，
	 * 还会继续判断候选记忆是否仍然有效、是否适合进入本轮 Context。
	 */
	const recalled = await recallEvents(store, principal, question, { now })

	/**
	 * 打印每一条历史记忆候选的召回决策。
	 *
	 * decisions 用于观察：
	 * - 哪些记忆被检索出来
	 * - 哪些最终被保留或过滤
	 * - 保留 / 过滤的具体原因
	 */
	console.log('\n========== 历史记忆候选与筛选原因 ==========')
	for (const decision of recalled.decisions) {
		console.dir(decision, { depth: null })
	}

	// selected 才是真正允许进入本轮模型 Context 的历史记忆。
	console.log('\n========== 最终入选的历史记忆 ==========')
	console.dir(recalled.selected, { depth: null })

	/**
	 * 读取与当前问题相关的“当前事实”。
	 *
	 * 历史 Memory 代表过去保存的信息；
	 * currentFacts 代表业务系统当前状态。
	 *
	 * 当两者发生冲突时，通常应该优先相信更新的当前事实。
	 */
	const currentDecision = getCurrentDecision(currentFacts, principal, now)

	/**
	 * 组装本轮真正发送给模型的 messages。
	 *
	 * 输入可能同时包含：
	 * - Thread 当前会话状态
	 * - 用户本次问题
	 * - 精确读取的回答偏好
	 * - 召回并筛选后的长期记忆
	 * - 当前业务事实
	 *
	 * 也就是说：
	 * “Store 中存在某条记忆”并不代表它一定会进入模型 Context。
	 */
	const messages = buildModelInput({
		state: threadState,
		question,
		preferences,
		memories: recalled.selected,
		currentDecision
	})

	/**
	 * 打印最终模型输入。
	 *
	 * 这一部分非常重要，因为真正影响模型回答的，
	 * 不是 Store 里保存了什么，而是最终 messages 中实际包含了什么。
	 */
	console.log('\n========== 本次真正准备发送的 messages ==========')

	for (const [index, message] of messages.entries()) {
		console.log(`\n[${index}] ${message.role}\n${message.content}`)
	}

	/**
	 * answer 模式才真正调用 DeepSeek。
	 *
	 * demo 模式停留在 Context 构造阶段，
	 * 方便单独观察和调试 Memory 的召回行为。
	 */
	if (mode === 'answer') {
		const response = await createAnswerModel().invoke(messages)

		console.log('\n========== DeepSeek 回答 ==========')
		console.log(response.content)
	} else {
		console.log(
			'\n当前只运行真实向量召回。执行 npm run answer 可继续调用 DeepSeek。'
		)
	}
}

main().catch((error) => {
	console.error(error.message)
	process.exitCode = 1
})

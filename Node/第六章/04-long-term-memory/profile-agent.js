import { ChatDeepSeek } from '@langchain/deepseek'
import { createAgent, tool } from 'langchain'
import { z } from 'zod'
import {
	deleteUserProfile,
	loadUserProfile,
	saveUserProfile
} from './profile-store.js'
import { closeStorage, createStorage } from './storage.js'

const BLUEWHALE_USER = {
	tenantId: 'bluewhale',
	userId: 'user-1001'
}

const OTHER_USER = {
	tenantId: 'bluewhale',
	userId: 'user-1002'
}

const OTHER_TENANT = {
	tenantId: 'star-retail',
	userId: 'user-1001'
}

const contextSchema = z.object({
	tenantId: z.string(),
	userId: z.string()
})

const profileSchema = z.object({
	responseLanguage: z
		.enum(['zh-CN', 'en-US'])
		.describe('用户希望回答使用的语言'),
	answerStyle: z
		.enum(['conclusion_first', 'detailed'])
		.describe('conclusion_first 表示先给结论，detailed 表示详细解释'),
	contactWindow: z.string().describe('允许人工联系用户的时间')
})

/** 创建本节使用的 DeepSeek Chat Model。 */
function createModel() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	return new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 2
	})
}

/** 创建写入和读取用户画像的 Tool。 */
function createProfileTools() {
	const saveProfile = tool(
		async (profile, runtime) => {
			const saved = await saveUserProfile(
				runtime.store,
				runtime.context,
				profile
			)

			return JSON.stringify({ saved: true, profile: saved })
		},
		{
			name: 'save_user_profile',
			description:
				'当用户明确要求记住自己的回答语言、回答风格和人工联系时间时，保存完整用户画像。',
			schema: profileSchema
		}
	)

	const getProfile = tool(
		async (_input, runtime) => {
			const profile = await loadUserProfile(
				runtime.store,
				runtime.context
			)

			return JSON.stringify({ found: Boolean(profile), profile })
		},
		{
			name: 'get_user_profile',
			description:
				'读取当前已登录用户保存的回答语言、回答风格和人工联系时间。',
			schema: z.object({})
		}
	)

	return [saveProfile, getProfile]
}

/** 使用同一套 Store 和 Checkpointer 创建用户偏好 Agent。 */
function createProfileAgent(storage) {
	return createAgent({
		model: createModel(),
		tools: createProfileTools(),
		checkpointer: storage.checkpointer,
		store: storage.store,
		contextSchema,
		systemPrompt: `你是企业售后 Agent。
用户明确说“记住”沟通偏好时，必须调用 save_user_profile。
用户要求按照以前的偏好回答时，必须先调用 get_user_profile。
没有读取到画像时，要明确说明尚未保存，不能猜测。
用户和租户身份由 Runtime Context 提供，不要要求用户在对话中提供身份 ID。`
	})
}

/** 创建 Agent Config；生产项目中的 principal 应来自认证中间件。 */
function createRunConfig(principal, threadId) {
	return {
		configurable: { thread_id: threadId },
		context: principal
	}
}

/** 把一次 Agent Run 中的模型和 Tool 消息打印出来。 */
function printRun(label, state) {
	console.log(`\n========== ${label} ==========`)
	console.table(
		state.messages.map((message, index) => ({
			序号: index + 1,
			类型: message.getType(),
			Tool: message.name ?? '',
			内容:
				typeof message.content === 'string'
					? message.content.replaceAll(/\s+/g, ' ').slice(0, 160)
					: JSON.stringify(message.content).slice(0, 160)
		}))
	)
}

/** 在 Thread A 中让 Agent 明确保存用户偏好。 */
async function remember(agent, store) {
	const state = await agent.invoke(
		{
			messages: [
				{
					role: 'user',
					content:
						'请记住我的沟通偏好：以后使用中文回答，先给结论；如果需要人工联系，请安排在工作日 19:00 以后。'
				}
			]
		},
		createRunConfig(BLUEWHALE_USER, 'profile-write-thread-1001')
	)

	printRun('Thread A：保存用户画像', state)

	const profile = await loadUserProfile(store, BLUEWHALE_USER)
	if (!profile) {
		throw new Error('模型没有成功调用 save_user_profile。')
	}

	console.log('\nStore 中实际保存的画像：')
	console.log(profile)
}

/** 在全新的 Thread B 中读取 Store，并按照旧偏好回答。 */
async function recall(agent) {
	const state = await agent.invoke(
		{
			messages: [
				{
					role: 'user',
					content:
						'这是一个新会话。请按照我以前保存的偏好，告诉我订单超过退款阈值后应该怎样处理。'
				}
			]
		},
		createRunConfig(BLUEWHALE_USER, 'profile-read-thread-1001')
	)

	printRun('Thread B：读取长期记忆', state)

	const usedProfileTool = state.messages.some(
		(message) =>
			message.getType() === 'tool' && message.name === 'get_user_profile'
	)

	if (!usedProfileTool) {
		throw new Error('模型没有按照要求调用 get_user_profile。')
	}
}

/** 验证相同用户 ID 在不同租户、不同用户在相同租户中都无法读取该画像。 */
async function verifyIsolation(store) {
	console.log('\n========== 用户与租户隔离 ==========')
	console.table([
		{
			读取身份: 'bluewhale / user-1001',
			读取结果: Boolean(await loadUserProfile(store, BLUEWHALE_USER))
		},
		{
			读取身份: 'bluewhale / user-1002',
			读取结果: Boolean(await loadUserProfile(store, OTHER_USER))
		},
		{
			读取身份: 'star-retail / user-1001',
			读取结果: Boolean(await loadUserProfile(store, OTHER_TENANT))
		}
	])
}

/** 删除三组课程数据，保证实验可以重新执行。 */
async function reset(store) {
	await Promise.all([
		deleteUserProfile(store, BLUEWHALE_USER),
		deleteUserProfile(store, OTHER_USER),
		deleteUserProfile(store, OTHER_TENANT)
	])
	console.log('课程用户画像已经清理。')
}

async function main() {
	const command = process.argv[2] ?? 'demo'
	const storage = createStorage()

	try {
		if (command === 'reset') {
			await reset(storage.store)
			return
		}

		if (command === 'isolation') {
			await verifyIsolation(storage.store)
			return
		}

		const agent = createProfileAgent(storage)

		if (command === 'remember') {
			await remember(agent, storage.store)
			return
		}

		if (command === 'recall') {
			await recall(agent)
			return
		}

		if (command === 'demo') {
			await reset(storage.store)
			await remember(agent, storage.store)
			await recall(agent)
			await verifyIsolation(storage.store)
			return
		}

		throw new Error(`未知命令：${command}`)
	} finally {
		await closeStorage(storage)
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

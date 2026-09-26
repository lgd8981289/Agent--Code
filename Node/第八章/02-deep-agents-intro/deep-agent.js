import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatDeepSeek } from '@langchain/deepseek'
import { createDeepAgent, FilesystemBackend } from 'deepagents'

function messageText(message) {
	if (typeof message?.content === 'string') return message.content
	if (!Array.isArray(message?.content)) return ''
	return message.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
}

function printRun(result) {
	console.log('本次执行轨迹：')
	for (const message of result.messages) {
		for (const call of message.tool_calls ?? []) {
			console.log(`模型请求调用 ${call.name}：`, call.args)
		}
		if (message.tool_call_id) {
			console.log(`工具 ${message.name} 返回：`, messageText(message))
		}
	}

	console.log('\n最终回答：', messageText(result.messages.at(-1)))
}

async function main() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先配置模型 API Key。')
	}

	const model = new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0
	})

	const workspaceDir = fileURLToPath(new URL('./workspace/', import.meta.url))
	await mkdir(workspaceDir, { recursive: true })

	const agent = await createDeepAgent({
		model,
		backend: new FilesystemBackend({ rootDir: workspaceDir, virtualMode: true }),
		systemPrompt: `你负责制作互动剧情游戏的世界观设定。
这次只交付世界观初稿：把三条明确且不冲突的世界规则保存到 /game/world.md。
交付前核对已经保存的内容，再向用户说明结果。`
	})

	const result = await agent.invoke({
		messages: [{
			role: 'user',
			content: '游戏发生在一座失去通信的太空站，请设计三条世界观规则。'
		}]
	}, { recursionLimit: 20 })

	printRun(result)

	const wroteWorld = result.messages.some((message) =>
		message.name === 'write_file' &&
		messageText(message).includes("Successfully wrote to '/game/world.md'")
	)
	if (!wroteWorld) {
		throw new Error('Agent 没有成功写入 /game/world.md，请检查上面的工具调用轨迹。')
	}

	const outputPath = join(workspaceDir, 'game', 'world.md')
	const content = await readFile(outputPath, 'utf8')
	if (!content.trim()) throw new Error('世界观文件已创建，但内容为空。')
	console.log('\n生成的文件：', outputPath)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FilesystemBackend } from 'deepagents'

const workspaceDir = fileURLToPath(new URL('./workspace/', import.meta.url))
const backend = new FilesystemBackend({
	rootDir: workspaceDir,
	virtualMode: true
})

const documents = {
	'/game/world.md': `# 世界观

故事发生在一座失去通信的太空站。
规则一：任何信息都无法从空间站传到外界，修复天线也不能恢复通信。
规则二：空气、水和能源有固定损耗，无法从外部补给。
规则三：所有谜团的原因都必须能在站内找到。
`,
	'/game/characters.md': `# 角色档案

林澜：空间站通信工程师，谨慎，习惯先排查设备故障。她知道通信断绝无法修复，但还没有向其他人说出原因。
周舟：空间站医生，负责照顾伤员，反对为节省物资而放弃救治。
陈岳：站长，负责分配剩余资源，隐瞒了上一轮物资盘点的异常。
每名角色都要有自己的目标；角色间的争执不能改变世界规则。
`,
	'/game/scenes/scene-01.md': `# 场景 01：控制室

林澜发现备用天线的电源仍然正常。她修好了天线，成功联系上地球。
地球方面答应派出救援飞船，站长因此决定停止物资配给。
`
}

const question = '场景 01 是否违反了已经确定的世界规则？'
const neededPaths = ['/game/world.md', '/game/scenes/scene-01.md']

/**
 * 确保 Workspace 中存在初始化所需的文档。
 * 已存在的文件不会被覆盖，只会创建缺失的文件。
 */
async function ensureDocuments() {
	// 确保 Workspace 根目录存在；如果父目录不存在则一并创建
	await mkdir(workspaceDir, { recursive: true })

	// 遍历预定义的所有文档：virtualPath 是虚拟路径，content 是文件内容
	for (const [virtualPath, content] of Object.entries(documents)) {
		// 将类似 /game/world.md 的虚拟路径转换成真实磁盘路径
		const diskPath = join(workspaceDir, virtualPath.slice(1))

		try {
			// 检查文件是否已经存在
			await access(diskPath)
		} catch (error) {
			// 如果不是“文件不存在”错误，说明出现了其他异常，直接抛出
			if (error.code !== 'ENOENT') throw error

			// 文件不存在时，通过 backend 创建文件并写入默认内容
			const result = await backend.write(virtualPath, content)

			// backend 写入失败时，将错误继续向上抛出
			if (result.error) throw new Error(result.error)
		}
	}
}

async function readDocument(virtualPath) {
	const result = await backend.read(virtualPath)
	if (result.error || typeof result.content !== 'string') {
		throw new Error(result.error ?? `无法读取 ${virtualPath}`)
	}
	return result.content
}

async function main() {
	// 确保 Workspace 中存在初始化所需的文档
	await ensureDocuments()

	const allPaths = Object.keys(documents)
	const allContents = await Promise.all(allPaths.map(readDocument))
	const neededContents = await Promise.all(neededPaths.map(readDocument))

	const allMessagesText = [question, ...allContents].join('\n')
	const selectedMessagesText = [question, ...neededContents].join('\n')

	console.log('本次任务：', question)
	console.log('Workspace 目录：', workspaceDir)
	console.log('工作区已有文件：', allPaths.join('、'))
	console.log('\n方案 A：把所有文件正文放进下一次模型输入')
	console.log('读取文件：', allPaths.join('、'))
	console.log('待发送文本长度：', allMessagesText.length, '字符')
	console.log('\n方案 B：按当前问题读取需要的文件')
	console.log('读取文件：', neededPaths.join('、'))
	console.log('待发送文本长度：', selectedMessagesText.length, '字符')
	console.log('方案 B 未加入模型输入：/game/characters.md')
	console.log('\n核对用到的原文：')
	for (let index = 0; index < neededPaths.length; index += 1) {
		console.log(`\n${neededPaths[index]}\n${neededContents[index]}`)
	}
	console.log('观察点：场景写了“成功联系上地球”，世界观规定“无法恢复通信”。')
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

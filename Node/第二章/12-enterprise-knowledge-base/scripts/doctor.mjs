import { MilvusClient } from '@zilliz/milvus2-sdk-node'

const checks = []

function record(name, passed, detail) {
	checks.push({ name, passed, detail })
	console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}：${detail}`)
}

const nodeMajor = Number(process.versions.node.split('.')[0])
record('Node.js', nodeMajor >= 22, `当前版本 ${process.versions.node}，要求 22.12.0 以上`)

record(
	'ZHIPU_API_KEY',
	Boolean(process.env.ZHIPU_API_KEY?.trim()),
	process.env.ZHIPU_API_KEY ? '已配置' : '未配置'
)

const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 512)
record(
	'Embedding 维度',
	[256, 512, 1024, 2048].includes(dimensions),
	String(dimensions)
)

const configuredAddress = process.env.MILVUS_ADDRESS ?? '127.0.0.1:19530'
const address = configuredAddress.replace(
	/(^|:\/\/)localhost(?=:\d+$)/,
	'$1127.0.0.1'
)
const client = new MilvusClient({
	address,
	token: process.env.MILVUS_TOKEN?.trim() || undefined
})

try {
	await client.connectPromise
	await client.listCollections()
	record('Milvus 连接', true, address)
} catch (error) {
	record(
		'Milvus 连接',
		false,
		error instanceof Error ? error.message : String(error)
	)
} finally {
	await client.closeConnection().catch(() => undefined)
}

if (checks.some((check) => !check.passed)) {
	process.exitCode = 1
} else {
	console.log('\n运行环境检查通过。')
}

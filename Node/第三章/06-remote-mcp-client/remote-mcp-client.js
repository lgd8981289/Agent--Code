import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const AMAP_MCP_URL = 'https://mcp.amap.com/mcp'
const DEFAULT_CITY = '北京'

/**
 * 使用学生自己的高德 Key 生成远程 MCP 地址。
 * Key 只在运行时读取，不写入源码，也不打印到终端。
 */
function createAmapMcpUrl() {
	const apiKey = process.env.AMAP_MAPS_API_KEY?.trim()

	if (!apiKey) {
		throw new Error(
			'缺少 AMAP_MAPS_API_KEY，请先在 .env 中配置高德 Web 服务 Key。'
		)
	}

	const url = new URL(AMAP_MCP_URL)
	url.searchParams.set('key', apiKey)

	return url
}

/**
 * 打印 Server 暴露的 Tool，帮助观察远程能力发现结果。
 */
function printTools(tools) {
	console.log(`\n发现 ${tools.length} 个 Tool：`)

	for (const [index, tool] of tools.entries()) {
		console.log(`${index + 1}. ${tool.name}`)
		console.log(`   ${tool.description?.trim().split('\n')[0] ?? '无描述'}`)
	}
}

/**
 * 打印 MCP Tool 返回的 Content，兼容文本和其他内容类型。
 */
function printToolResult(result) {
	console.log('\nTool 返回：')

	for (const content of result.content ?? []) {
		if (content.type === 'text') {
			console.log(content.text)
			continue
		}

		console.dir(content, { depth: 5 })
	}
}

/**
 * 连接高德地图远程 MCP Server，完成能力发现并查询城市天气。
 */
async function main() {
	let client

	try {
		// 读取高德 Key 并创建远程 MCP 地址
		const serverUrl = createAmapMcpUrl()
		// 创建远程 MCP 客户端
		const transport = new StreamableHTTPClientTransport(serverUrl)
		// 创建 MCP Client 实例
		client = new Client({
			name: 'agent-course-amap-mcp-client',
			version: '1.0.0'
		})

		console.log('正在连接高德地图远程 MCP Server...')
		console.log(`地址：${AMAP_MCP_URL}?key=***`)

		// 连接远程 MCP Server
		await client.connect(transport)

		console.log('连接成功')
		console.log(`协议版本：${transport.protocolVersion ?? 'Server 未返回'}`)
		console.log(
			`传输会话：${
				transport.sessionId
					? `Server 分配了 ${transport.sessionId}`
					: 'Server 未分配 Session ID'
			}`
		)

		const { tools } = await client.listTools()
		printTools(tools)

		// 查找 maps_weather Tool 并调用
		const weatherTool = tools.find((tool) => tool.name === 'maps_weather')

		if (!weatherTool) {
			throw new Error('高德 MCP Server 当前没有返回 maps_weather Tool。')
		}

		const city = process.env.AMAP_TEST_CITY?.trim() || DEFAULT_CITY

		console.log(`\n调用 Tool：${weatherTool.name}`)
		console.log(`查询城市：${city}`)

		// 调用远程 MCP Tool
		const result = await client.callTool({
			name: weatherTool.name,
			arguments: { city }
		})

		printToolResult(result)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		console.error('\n高德远程 MCP 调用失败：')

		if (message.includes('infocode') && message.includes('Unrecognized keys')) {
			console.error('高德 Server 拒绝了当前 Key，请检查 AMAP_MAPS_API_KEY。')
		} else {
			console.error(message)
		}

		process.exitCode = 1
	} finally {
		await client?.close().catch(() => {})
	}
}

await main()

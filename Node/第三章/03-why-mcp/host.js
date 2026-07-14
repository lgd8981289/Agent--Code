// 将 ES Module 的文件 URL 转换为本地文件路径。
import { fileURLToPath } from 'node:url'

// MCP Client：负责与指定的 MCP Server 建立连接并调用其能力。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

// stdio Client 传输层：通过子进程的 stdin、stdout 与 Server 通信。
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * 获取订单 MCP Server 入口文件的绝对路径。
 *
 * import.meta.url 表示当前文件地址；
 * new URL(...) 根据当前文件定位 order-mcp-server.js；
 * fileURLToPath(...) 再将文件 URL 转换成本地文件路径。
 */
const serverPath = fileURLToPath(
	new URL('./order-mcp-server.js', import.meta.url)
)

/** 打印步骤标题，方便观察 Host、Client 和 Server 之间的调用过程。 */
function printStep(title) {
	console.log(`\n================ ${title} ================`)
}

/**
 * 创建 MCP Client 实例。
 *
 * 这个 Client 是 Host 内部负责执行 MCP 协议通信的组件，
 * 它将与订单 MCP Server 建立一条独立连接。
 */
const client = new Client({
	name: 'after-sales-agent-client',
	version: '1.0.0'
})

/**
 * 创建 stdio Client 传输层。
 *
 * process.execPath：当前运行程序所使用的 Node.js 可执行文件；
 * args：传给 Node.js 的启动参数，这里是 Server 入口文件；
 * stderr: 'inherit'：将 Server 的错误输出直接显示在当前终端中。
 *
 * 连接时相当于执行：
 *
 * node order-mcp-server.js
 */
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [serverPath],
	stderr: 'inherit'
})

try {
	printStep('1. Host 启动')

	// 当前文件中的 Agent 调度逻辑属于 Host。
	console.log('[Host] 售后 Agent 开始处理订单查询任务')
	console.log('[Host] 创建 MCP Client，并指定要连接的订单 Server')

	printStep('2. Client 建立连接')

	/**
	 * 启动订单 MCP Server 子进程，
	 * 并通过 stdio 完成 MCP 初始化和连接握手。
	 */
	await client.connect(transport)

	console.log('[Client] 已连接订单 MCP Server')

	printStep('3. Client 发现能力')

	// 向 Server 查询当前可以使用的 MCP Tools。
	const { tools } = await client.listTools()

	console.log('[Client] Server 当前提供的工具：')

	// 打印每个工具的名称、用途和参数结构。
	for (const tool of tools) {
		console.log(`- ${tool.name}：${tool.description}`)
		console.dir(tool.inputSchema, { depth: null })
	}

	printStep('4. Host 发起工具调用')

	/**
	 * Host 根据当前任务决定需要使用哪个工具，
	 * 然后让 Client 按照 MCP 协议发起调用。
	 */
	console.log('[Host] 当前任务需要查询订单 A1024')
	console.log('[Host] 让 Client 调用 get_order')

	// 调用 Server 暴露的 get_order 工具，并传入订单号。
	const result = await client.callTool({
		name: 'get_order',
		arguments: {
			orderId: 'A1024'
		}
	})

	printStep('5. 结果返回 Host')

	// 从 MCP Tool 返回的 content 数组中找到文本类型的结果。
	const textContent = result.content.find((item) => item.type === 'text')

	// Server 返回的是 JSON 字符串，这里将其解析为 JavaScript 对象。
	const orderResult = textContent ? JSON.parse(textContent.text) : null

	console.log('[Client] 已收到 Server 返回的执行结果')
	console.log('[Host] 得到订单数据：')
	console.dir(orderResult, { depth: null })
} finally {
	/**
	 * 无论工具调用成功还是失败，都关闭 Client。
	 *
	 * Client 关闭后，stdio 连接以及由传输层启动的
	 * Server 子进程也会随之结束。
	 */
	await client.close()

	console.log('\n[Host] 本次任务结束，关闭 Client 和 Server 连接')
}

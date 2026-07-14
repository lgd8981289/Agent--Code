// MCP Server：用于注册并对外提供 MCP Tool。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// stdio 传输层：通过标准输入和标准输出与 MCP Client 通信。
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// 使用 Zod 定义和校验工具的输入参数。
import { z } from 'zod'

// 引入真实的订单查询能力。
// 当前示例使用 Map 模拟，实际项目中可以替换成数据库、HTTP 或 RPC 调用。
import { getOrderById } from './order-system.js'

/**
 * 创建订单 MCP Server。
 *
 * name：Server 的唯一名称，Client 可以通过它识别当前 Server。
 * version：当前 Server 的版本号。
 */
const server = new McpServer({
	name: 'order-mcp-server',
	version: '1.0.0'
})

/**
 * 注册一个名为 get_order 的 MCP Tool。
 *
 * 当 MCP Client 查询当前 Server 提供的工具时，
 * 可以发现该工具的名称、说明和参数结构。
 */
server.registerTool(
	'get_order',
	{
		// 向模型和 Client 说明这个工具的用途。
		description: '根据订单号查询订单信息',

		// 定义工具调用时需要传入的参数。
		// SDK 会根据该 Schema 校验 Client 传入的数据。
		inputSchema: {
			orderId: z.string().describe('订单号，例如 A1024')
		}
	},

	// 当 Client 调用 get_order 时，执行该处理函数。
	async ({ orderId }) => {
		/**
		 * stdio 模式下，标准输出 stdout 专门用于传输 MCP 协议消息。
		 * 普通日志必须写入标准错误 stderr，否则可能干扰协议通信。
		 */
		console.error(`[Server] 收到 get_order 调用，orderId=${orderId}`)

		// 调用真实订单系统，查询对应的订单信息。
		const result = await getOrderById(orderId)

		/**
		 * 按照 MCP Tool 的返回格式封装执行结果。
		 *
		 * content 表示工具返回的内容列表；
		 * type: 'text' 表示当前返回的是文本内容。
		 */
		return {
			content: [
				{
					type: 'text',

					// 将订单查询结果序列化为字符串后返回给 Client。
					text: JSON.stringify(result)
				}
			]
		}
	}
)

console.error('[Server] 订单 MCP Server 已启动，等待 Client 连接')

/**
 * 创建 stdio 传输层。
 *
 * Client 会启动当前 Server 进程，并通过：
 * - stdin 向 Server 发送 MCP 消息；
 * - stdout 接收 Server 返回的 MCP 消息。
 */
const transport = new StdioServerTransport()

// 将 MCP Server 与 stdio 传输层连接，开始监听 Client 的请求。
await server.connect(transport)

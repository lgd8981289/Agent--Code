/**
 * 文件作用：
 * 创建企业售后 MCP Client，配置现代协议协商、Elicitation、
 * MCP Apps 能力声明和 Bearer Token 认证。
 *
 * 章节定位：【本章重点】
 *
 * 建议阅读：
 * 重点理解 Client capabilities、Streamable HTTP Transport、
 * MCP_TOKEN 的发送位置和 Human-in-the-Loop 响应方式。
 */
import {
	Client,
	StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'

/**
 * 创建并连接售后 MCP Client。
 */
export async function createAfterSalesClient({
	token,
	autoConfirm = true,
	name = 'enterprise-after-sales-client'
}) {
	// 创建 Client，并声明支持 Elicitation 和 MCP Apps。
	const client = new Client(
		{ name, version: '1.0.0' },
		{
			versionNegotiation: { mode: 'auto' },
			capabilities: {
				elicitation: { form: {} },
				extensions: {
					'io.modelcontextprotocol/ui': {
						mimeTypes: ['text/html;profile=mcp-app']
					}
				}
			}
		}
	)

	// 处理 Server 发起的用户确认请求。
	client.setRequestHandler('elicitation/create', async (request) => {
		console.log(`\n[Human-in-the-Loop] ${request.params.message}`)

		return autoConfirm
			? { action: 'accept', content: { confirm: true } }
			: { action: 'decline' }
	})

	// 创建 Streamable HTTP 传输层，并携带身份认证 Token。
	const transport = new StreamableHTTPClientTransport(
		new URL(process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:3100/mcp'),
		{ authProvider: { token: async () => token } }
	)

	// 连接 MCP Server，并返回可直接使用的 Client。
	await client.connect(transport)
	return client
}

export function parseToolResult(result) {
	if (result.structuredContent) return result.structuredContent
	const text = result.content?.find((item) => item.type === 'text')?.text
	if (!text) throw new Error('Tool 没有返回可解析的结果')
	return JSON.parse(text)
}

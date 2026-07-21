import {
	Client,
	StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'

export async function createAfterSalesClient({
	token,
	autoConfirm = true,
	name = 'enterprise-after-sales-client'
}) {
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

	client.setRequestHandler('elicitation/create', async (request) => {
		console.log(`\n[Human-in-the-Loop] ${request.params.message}`)
		return autoConfirm
			? { action: 'accept', content: { confirm: true } }
			: { action: 'decline' }
	})

	const transport = new StreamableHTTPClientTransport(
		new URL(process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:3100/mcp'),
		{ authProvider: { token: async () => token } }
	)

	await client.connect(transport)
	return client
}

export function parseToolResult(result) {
	if (result.structuredContent) return result.structuredContent
	const text = result.content?.find((item) => item.type === 'text')?.text
	if (!text) throw new Error('Tool 没有返回可解析的结果')
	return JSON.parse(text)
}

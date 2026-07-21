import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'

import { authenticate, principalFromAuthInfo } from './auth.js'
import { createAfterSalesMcpServer } from './mcp-server.js'

const port = Number(process.env.PORT ?? 3100)
const appPath = new URL('../dist/index.html', import.meta.url)

let appHtml
try {
	appHtml = await readFile(appPath, 'utf8')
} catch {
	throw new Error('没有找到 MCP App 构建结果，请先执行 npm run build:app')
}

const mcpHandler = createMcpHandler(
	({ authInfo }) => {
		const principal = principalFromAuthInfo(authInfo)
		if (!principal) throw new Error('MCP 请求缺少有效身份')
		return createAfterSalesMcpServer({ principal, appHtml })
	},
	{
		legacy: 'reject',
		responseMode: 'auto',
		onerror: (error) => console.error('[MCP]', error)
	}
)

const nodeMcpHandler = toNodeHandler(mcpHandler, {
	onerror: (error) => console.error('[HTTP Adapter]', error)
})

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

	if (url.pathname === '/health') {
		response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
		response.end(JSON.stringify({ ok: true, service: 'enterprise-after-sales-mcp' }))
		return
	}

	if (url.pathname !== '/mcp') {
		response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
		response.end(JSON.stringify({ error: 'NOT_FOUND' }))
		return
	}

	const auth = authenticate(request.headers.authorization)
	if (!auth) {
		response.writeHead(401, {
			'content-type': 'application/json; charset=utf-8',
			'www-authenticate': 'Bearer realm="enterprise-after-sales-mcp"'
		})
		response.end(JSON.stringify({ error: 'UNAUTHORIZED', message: '请提供有效的 Bearer Token' }))
		return
	}

	request.auth = auth.authInfo
	await nodeMcpHandler(request, response)
})

server.listen(port, '127.0.0.1', () => {
	console.log(`企业售后 MCP Server：http://127.0.0.1:${port}/mcp`)
	console.log(`健康检查：http://127.0.0.1:${port}/health`)
})

async function shutdown() {
	await mcpHandler.close()
	server.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

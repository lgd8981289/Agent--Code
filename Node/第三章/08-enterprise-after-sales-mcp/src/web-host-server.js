import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callDeepSeek, model } from './deepseek-client.js'
import { createAfterSalesClient } from './mcp-client.js'

const hostPort = Number(process.env.WEB_HOST_PORT ?? 3200)
const sandboxPort = Number(process.env.WEB_SANDBOX_PORT ?? 3201)
const hostName = '127.0.0.1'
const distDirectory = fileURLToPath(new URL('../dist-web-host', import.meta.url))

class ElicitationNeeded extends Error {
	constructor(message) {
		super(message)
		this.name = 'ElicitationNeeded'
	}
}

const mimeTypes = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2'
}

function sendJson(response, statusCode, data) {
	response.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	})
	response.end(JSON.stringify(data))
}

async function readJsonBody(request) {
	let body = ''

	for await (const chunk of request) {
		body += chunk
		if (body.length > 1024 * 1024) throw new Error('请求体超过 1 MB 限制')
	}

	return JSON.parse(body || '{}')
}

function safeFilePath(pathname) {
	const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
	const filePath = resolve(distDirectory, relativePath)
	const rootPrefix = `${resolve(distDirectory)}${sep}`

	if (filePath !== resolve(distDirectory) && !filePath.startsWith(rootPrefix)) {
		return null
	}

	return filePath
}

async function sendFile(response, pathname, extraHeaders = {}) {
	const filePath = safeFilePath(pathname)
	if (!filePath) return false

	try {
		if (!(await stat(filePath)).isFile()) return false
		const content = await readFile(filePath)
		response.writeHead(200, {
			'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
			'x-content-type-options': 'nosniff',
			...extraHeaders
		})
		response.end(content)
		return true
	} catch {
		return false
	}
}

function sanitizeCspDomains(domains) {
	if (!Array.isArray(domains)) return []
	return domains.filter(
		(domain) => typeof domain === 'string' && !/[;\r\n'" ]/.test(domain)
	)
}

/**
 * MCP App 会被放入独立沙箱。
 * CSP 由 Host 按 Resource 声明生成，App 无法在 HTML 内自行放宽权限。
 */
function buildSandboxCsp(csp = {}) {
	const resourceDomains = sanitizeCspDomains(csp.resourceDomains).join(' ')
	const connectDomains = sanitizeCspDomains(csp.connectDomains).join(' ')
	const frameDomains = sanitizeCspDomains(csp.frameDomains).join(' ')
	const baseUriDomains = sanitizeCspDomains(csp.baseUriDomains).join(' ')

	return [
		"default-src 'self' 'unsafe-inline'",
		`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
		`style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
		`img-src 'self' data: blob: ${resourceDomains}`.trim(),
		`font-src 'self' data: blob: ${resourceDomains}`.trim(),
		`connect-src 'self' ${connectDomains}`.trim(),
		frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
		"object-src 'none'",
		baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'"
	].join('; ')
}

async function withMcpClient(token, decision, action) {
	const client = await createAfterSalesClient({
		token,
		autoConfirm: false,
		name: 'enterprise-after-sales-web-host'
	})

	client.setRequestHandler('elicitation/create', async (request) => {
		if (decision === 'accept') {
			return { action: 'accept', content: { confirm: true } }
		}
		if (decision === 'decline') return { action: 'decline' }
		throw new ElicitationNeeded(request.params.message)
	})

	try {
		return await action(client)
	} finally {
		await client.close()
	}
}

const hostServer = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

	if (request.method === 'GET' && url.pathname === '/api/config') {
		sendJson(response, 200, {
			sandboxUrl: `http://${hostName}:${sandboxPort}/sandbox.html`,
			model
		})
		return
	}

	if (request.method === 'POST' && url.pathname === '/api/mcp/tools') {
		try {
			const { token } = await readJsonBody(request)
			const result = await withMcpClient(token, 'prompt', (client) =>
				client.listTools()
			)
			sendJson(response, 200, result)
		} catch (error) {
			sendJson(response, 500, {
				error: error instanceof Error ? error.message : String(error)
			})
		}
		return
	}

	if (request.method === 'POST' && url.pathname === '/api/mcp/call') {
		try {
			const { token, name, arguments: args, decision = 'prompt' } =
				await readJsonBody(request)
			const result = await withMcpClient(token, decision, (client) =>
				client.callTool({ name, arguments: args })
			)
			sendJson(response, 200, { kind: 'result', result })
		} catch (error) {
			if (error instanceof ElicitationNeeded) {
				sendJson(response, 200, { kind: 'elicitation', message: error.message })
				return
			}

			sendJson(response, 500, {
				error: error instanceof Error ? error.message : String(error)
			})
		}
		return
	}

	if (request.method === 'POST' && url.pathname === '/api/mcp/resource') {
		try {
			const { token, uri } = await readJsonBody(request)
			const result = await withMcpClient(token, 'prompt', (client) =>
				client.readResource({ uri })
			)
			sendJson(response, 200, result)
		} catch (error) {
			sendJson(response, 500, {
				error: error instanceof Error ? error.message : String(error)
			})
		}
		return
	}

	if (request.method === 'POST' && url.pathname === '/api/model') {
		try {
			const { messages, tools } = await readJsonBody(request)
			if (!Array.isArray(messages) || !Array.isArray(tools)) {
				throw new Error('messages 和 tools 必须是数组')
			}

			const message = await callDeepSeek({ messages, tools })
			sendJson(response, 200, { message })
		} catch (error) {
			sendJson(response, 500, {
				error: error instanceof Error ? error.message : String(error)
			})
		}
		return
	}

	// sandbox.html 只能从独立的 Sandbox Origin 加载。
	if (url.pathname === '/sandbox.html') {
		response.writeHead(404).end()
		return
	}

	if (request.method === 'GET' && (await sendFile(response, url.pathname))) return

	response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
	response.end('Not Found')
})

const sandboxServer = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

	if (request.method !== 'GET') {
		response.writeHead(405).end()
		return
	}

	if (url.pathname === '/' || url.pathname === '/sandbox.html') {
		let csp = {}
		try {
			csp = JSON.parse(url.searchParams.get('csp') ?? '{}')
		} catch {
			// 无效配置使用最严格的默认 CSP。
		}

		const sent = await sendFile(response, '/sandbox.html', {
			'content-security-policy': buildSandboxCsp(csp),
			'cache-control': 'no-store'
		})
		if (sent) return
	}

	// Vite 构建的 Sandbox 脚本必须与沙箱同源。
	if (url.pathname.startsWith('/assets/') && (await sendFile(response, url.pathname))) {
		return
	}

	response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
	response.end('Not Found')
})

hostServer.listen(hostPort, hostName, () => {
	console.log(`MCP Apps Web Host：http://${hostName}:${hostPort}`)
})

sandboxServer.listen(sandboxPort, hostName, () => {
	console.log(`MCP Apps Sandbox：http://${hostName}:${sandboxPort}`)
})

function shutdown() {
	hostServer.close()
	sandboxServer.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

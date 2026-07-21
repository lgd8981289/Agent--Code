import { buildAllowAttribute } from '@modelcontextprotocol/ext-apps/app-bridge'

if (window.self === window.top) {
	throw new Error('Sandbox 只能在 Host iframe 中运行')
}

if (!document.referrer) throw new Error('Sandbox 无法确认 Host 来源')

const hostOrigin = new URL(document.referrer).origin
const sandboxOrigin = window.location.origin
const innerFrame = document.createElement('iframe')

innerFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
document.body.append(innerFrame)

const resourceReadyMethod = 'ui/notifications/sandbox-resource-ready'
const proxyReadyMethod = 'ui/notifications/sandbox-proxy-ready'

/**
 * 外层 Sandbox 仅负责在 Host 与内层 MCP App 之间转发 JSON-RPC。
 * Host 不能直接访问 App DOM，App 也不能访问 Host DOM。
 */
window.addEventListener('message', (event) => {
	if (event.source === window.parent) {
		if (event.origin !== hostOrigin) return

		if (event.data?.method === resourceReadyMethod) {
			const { html, permissions, sandbox } = event.data.params ?? {}
			if (typeof sandbox === 'string') innerFrame.setAttribute('sandbox', sandbox)

			const allow = buildAllowAttribute(permissions)
			if (allow) innerFrame.setAttribute('allow', allow)

			if (typeof html === 'string') {
				const documentTarget = innerFrame.contentDocument
				if (!documentTarget) throw new Error('无法创建 MCP App 内层文档')
				documentTarget.open()
				documentTarget.write(html)
				documentTarget.close()
			}
			return
		}

		innerFrame.contentWindow?.postMessage(event.data, '*')
		return
	}

	if (event.source === innerFrame.contentWindow) {
		if (event.origin !== sandboxOrigin) return
		window.parent.postMessage(event.data, hostOrigin)
	}
})

window.parent.postMessage(
	{ jsonrpc: '2.0', method: proxyReadyMethod, params: {} },
	hostOrigin
)

import {
	AppBridge,
	PostMessageTransport,
	RESOURCE_MIME_TYPE,
	buildAllowAttribute,
	getToolUiResourceUri
} from '@modelcontextprotocol/ext-apps/app-bridge'

import './style.css'

const identityElement = document.querySelector('#identity')
const connectionDotElement = document.querySelector('#connection-dot')
const connectionTextElement = document.querySelector('#connection-text')
const toolCountElement = document.querySelector('#tool-count')
const modelNameElement = document.querySelector('#model-name')
const timelineElement = document.querySelector('#timeline')
const chatFormElement = document.querySelector('#chat-form')
const questionElement = document.querySelector('#question')
const sendButtonElement = document.querySelector('#send-button')
const resetButtonElement = document.querySelector('#reset-button')
const appDemoButtonElement = document.querySelector('#app-demo-button')
const modalElement = document.querySelector('#confirm-modal')
const confirmMessageElement = document.querySelector('#confirm-message')
const acceptButtonElement = document.querySelector('#accept-button')
const declineButtonElement = document.querySelector('#decline-button')

const identityLabels = {
	'token-blue-service': '蓝鲸科技客服',
	'token-blue-finance': '蓝鲸科技财务',
	'token-star-service': '星河零售客服'
}

let config
let mcpTools = []
let toolsByName = new Map()
let messages = createConversationMessages()
let busy = false
let confirmationResolver
const appBridges = []

function createConversationMessages() {
	return [
		{
			role: 'system',
			content: [
				'你是企业售后 Agent。',
				'订单、物流和规则必须通过工具查询，不能编造。',
				'先调用只读工具核对事实，只有用户明确要求提交时才调用写操作。',
				'回答使用简洁的中文，不要使用 Markdown 表格。',
				'当财务用户要求查看已完成的批量审核报告时，调用 get_batch_review_report。'
			].join('\n')
		}
	]
}

function scrollToLatest() {
	requestAnimationFrame(() => {
		timelineElement.scrollTo({
			top: timelineElement.scrollHeight,
			behavior: 'smooth'
		})
	})
}

function setConnection(status, text) {
	connectionDotElement.className = `connection-dot ${status}`
	connectionTextElement.textContent = text
}

function setBusy(value) {
	busy = value
	identityElement.disabled = value
	questionElement.disabled = value
	sendButtonElement.disabled = value
	appDemoButtonElement.disabled = value
}

function appendMessage(role, text) {
	const article = document.createElement('article')
	article.className = `message ${role}`

	const avatar = document.createElement('div')
	avatar.className = 'avatar'
	avatar.textContent = role === 'user' ? '我' : 'AI'

	const body = document.createElement('div')
	body.className = 'message-body'

	const meta = document.createElement('p')
	meta.className = 'message-meta'
	meta.textContent = role === 'user' ? '用户' : '售后 Agent'

	const content = document.createElement('div')
	content.className = 'message-content'
	content.textContent = text

	body.append(meta, content)
	article.append(avatar, body)
	timelineElement.append(article)
	scrollToLatest()
	return body
}

function appendStatus(text) {
	const element = document.createElement('div')
	element.className = 'status-line'
	element.innerHTML = '<span></span>'
	element.append(document.createTextNode(text))
	timelineElement.append(element)
	scrollToLatest()
	return element
}

function formatJson(value) {
	return JSON.stringify(value, null, 2)
}

function extractToolText(result) {
	return (
		result.content?.find((item) => item.type === 'text')?.text ??
		JSON.stringify(result.structuredContent ?? {})
	)
}

function extractStructuredResult(result) {
	if (result.structuredContent) return result.structuredContent
	return JSON.parse(extractToolText(result))
}

function appendToolCard(name, args) {
	const card = document.createElement('details')
	card.className = 'tool-card'

	const summary = document.createElement('summary')
	const title = document.createElement('span')
	title.innerHTML = `<i></i><strong>${name}</strong>`
	const state = document.createElement('em')
	state.textContent = '调用中'
	summary.append(title, state)

	const content = document.createElement('div')
	content.className = 'tool-card-content'
	const input = document.createElement('pre')
	input.textContent = formatJson(args)
	content.append(input)
	card.append(summary, content)
	timelineElement.append(card)
	scrollToLatest()

	return {
		complete(result) {
			state.textContent = result.isError ? '执行失败' : '执行完成'
			state.className = result.isError ? 'error' : 'success'
			const output = document.createElement('pre')
			output.textContent = extractToolText(result)
			content.append(output)
		},
		fail(error) {
			state.textContent = '执行失败'
			state.className = 'error'
			const output = document.createElement('pre')
			output.textContent =
				error instanceof Error ? error.message : String(error)
			content.append(output)
		}
	}
}

function showConfirmation(message) {
	confirmMessageElement.textContent = message
	modalElement.hidden = false
	acceptButtonElement.focus()

	return new Promise((resolve) => {
		confirmationResolver = resolve
	})
}

/**
 * 关闭确认弹窗，并返回用户的确认结果。
 */
function finishConfirmation(accepted) {
	modalElement.hidden = true

	// 取出并清空当前确认请求的 Promise resolve。
	const resolve = confirmationResolver
	confirmationResolver = undefined

	// 将用户的同意或拒绝结果返回给等待中的确认流程。
	resolve?.(
		accepted
			? { action: 'accept', content: { confirm: true } }
			: { action: 'decline' }
	)
}

async function closeAppBridges() {
	await Promise.allSettled(
		appBridges.splice(0).map((bridge) => bridge.teardownResource({}))
	)
}

async function connectMcp(token) {
	setConnection('connecting', '正在连接 MCP Server……')
	await closeAppBridges()
	const listed = await postJson('/api/mcp/tools', { token })
	mcpTools = listed.tools
	toolsByName = new Map(mcpTools.map((tool) => [tool.name, tool]))
	toolCountElement.textContent = String(mcpTools.length)
	setConnection('connected', `${identityLabels[token]} 已连接`)
}

async function postJson(url, body) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	})
	const data = await response.json()
	if (!response.ok)
		throw new Error(data.error ?? `请求失败：${response.status}`)
	return data
}

function openAiTools() {
	return mcpTools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema
		}
	}))
}

async function callModel() {
	const response = await fetch('/api/model', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ messages, tools: openAiTools() })
	})
	const data = await response.json()
	if (!response.ok) throw new Error(data.error ?? '模型调用失败')
	return data.message
}

/**
 * 调用 MCP Tool，并同步更新调用卡片和 MCP App。
 */
async function callMcpTool(name, args, { renderApp = true } = {}) {
	// 创建 Tool 调用卡片，展示工具名称和参数。
	const card = appendToolCard(name, args)

	try {
		// 调用 MCP Tool，并等待结果。
		const result = await requestMcpTool(name, args)
		card.complete(result)

		// Tool 绑定了 UI Resource 时，将结果渲染为 MCP App。
		const tool = toolsByName.get(name)
		if (renderApp && tool && getToolUiResourceUri(tool)) {
			await renderMcpApp({ tool, args, result })
		}

		return result
	} catch (error) {
		// 标记 Tool 调用失败，并继续向上抛出异常。
		card.fail(error)
		throw error
	}
}

/**
 * 调用 MCP Tool，并处理可能出现的用户确认流程。
 */
async function requestMcpTool(name, args) {
	// 第一次调用 Tool，允许 Server 请求用户确认。
	let response = await postJson('/api/mcp/call', {
		token: identityElement.value,
		name,
		arguments: args,
		decision: 'prompt'
	})

	// Server 要求确认时，收集用户选择并重新调用原 Tool。
	if (response.kind === 'elicitation') {
		const answer = await showConfirmation(response.message)

		response = await postJson('/api/mcp/call', {
			token: identityElement.value,
			name,
			arguments: args,
			decision: answer.action === 'accept' ? 'accept' : 'decline'
		})
	}

	// 最终必须返回正常的 Tool Result。
	if (response.kind !== 'result') {
		throw new Error('MCP Tool 没有返回有效结果')
	}

	return response.result
}

async function runAgentTurn(question) {
	appendMessage('user', question)
	messages.push({ role: 'user', content: question })

	const thinking = appendStatus('Agent 正在思考并选择工具……')

	try {
		for (let round = 1; round <= 8; round += 1) {
			const assistantMessage = await callModel()
			messages.push(assistantMessage)

			if (assistantMessage.content?.trim()) {
				appendMessage('assistant', assistantMessage.content)
			}

			if (!assistantMessage.tool_calls?.length) return

			for (const toolCall of assistantMessage.tool_calls) {
				const args = JSON.parse(toolCall.function.arguments || '{}')
				const result = await callMcpTool(toolCall.function.name, args)
				messages.push({
					role: 'tool',
					tool_call_id: toolCall.id,
					content: extractToolText(result)
				})
			}
		}

		throw new Error('Agent 超过了单轮最大 Tool Calling 次数')
	} finally {
		thinking.remove()
	}
}

function waitForSandbox(iframe, url) {
	return new Promise((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			window.removeEventListener('message', listener)
			reject(new Error('MCP App Sandbox 启动超时'))
		}, 5000)

		const listener = (event) => {
			if (
				event.source === iframe.contentWindow &&
				event.data?.method === 'ui/notifications/sandbox-proxy-ready'
			) {
				window.clearTimeout(timeout)
				window.removeEventListener('message', listener)
				resolve()
			}
		}

		window.addEventListener('message', listener)
		iframe.src = url
	})
}

async function readAppResource(tool) {
	const uri = getToolUiResourceUri(tool)
	const response = await postJson('/api/mcp/resource', {
		token: identityElement.value,
		uri
	})
	const content = response.contents?.[0]

	if (!content) throw new Error(`没有找到 MCP App Resource：${uri}`)
	if (content.mimeType !== RESOURCE_MIME_TYPE) {
		throw new Error(`MCP App MIME Type 不正确：${content.mimeType}`)
	}

	return {
		html: 'blob' in content ? atob(content.blob) : content.text,
		csp: content._meta?.ui?.csp,
		permissions: content._meta?.ui?.permissions
	}
}

/**
 * 读取 Tool 绑定的 UI Resource，并在 Sandbox iframe 中渲染 MCP App。
 */
async function renderMcpApp({ tool, args, result }) {
	// 创建 MCP App 外层容器和加载状态。
	const appShell = document.createElement('section')
	appShell.className = 'mcp-app-shell'
	appShell.innerHTML = `
		<header>
			<div><span></span>MCP APP</div>
			<strong>${getToolUiResourceUri(tool)}</strong>
		</header>`

	const loading = document.createElement('div')
	loading.className = 'app-loading'
	loading.textContent = '正在从 MCP Server 加载 UI Resource……'
	appShell.append(loading)
	timelineElement.append(appShell)
	scrollToLatest()

	try {
		// 从 MCP Server 读取 App HTML、安全策略和权限配置。
		const { html, csp, permissions } = await readAppResource(tool)

		// 使用受限 iframe 隔离运行 MCP App。
		const iframe = document.createElement('iframe')
		iframe.title = '批量退款审核报告'
		iframe.className = 'mcp-app-frame'
		iframe.setAttribute(
			'sandbox',
			'allow-scripts allow-same-origin allow-forms'
		)

		const allow = buildAllowAttribute(permissions)
		if (allow) iframe.setAttribute('allow', allow)

		loading.replaceWith(iframe)

		// 加载独立 Sandbox 页面，并传入 CSP 配置。
		const sandboxUrl = new URL(config.sandboxUrl)
		if (csp) sandboxUrl.searchParams.set('csp', JSON.stringify(csp))
		await waitForSandbox(iframe, sandboxUrl.href)

		// 创建 Host 与 iframe 内 MCP App 之间的通信桥接。
		const bridge = new AppBridge(
			null,
			{
				name: 'enterprise-after-sales-web-host',
				version: '1.0.0'
			},
			{
				openLinks: {},
				serverTools: {},
				serverResources: {}
			},
			{
				hostContext: {
					theme: 'light',
					platform: 'web',
					locale: 'zh-CN',
					timeZone: 'Asia/Shanghai',
					displayMode: 'inline',
					availableDisplayModes: ['inline'],
					containerDimensions: {
						maxHeight: 900
					}
				}
			}
		)

		// 注册 MCP App 发给 Host 的事件处理器。
		bridge.onopenlink = async ({ url }) => {
			window.open(url, '_blank', 'noopener,noreferrer')
			return {}
		}
		bridge.onmessage = async () => ({})
		bridge.onupdatemodelcontext = async () => ({})
		bridge.onsizechange = ({ height }) => {
			if (height) {
				iframe.style.height = `${Math.min(Math.max(height, 280), 900)}px`
			}
		}
		bridge.onrequestdisplaymode = async () => ({
			mode: 'inline'
		})

		const initialized = new Promise((resolve) => {
			bridge.oninitialized = resolve
		})

		// 建立通信，并依次发送 UI Resource、Tool 参数和 Tool Result。
		await bridge.connect(
			new PostMessageTransport(iframe.contentWindow, iframe.contentWindow)
		)
		// 第一份：MCP App 的页面资源
		await bridge.sendSandboxResourceReady({
			html,
			csp,
			permissions
		})
		await initialized
		// 第二份：Tool 调用参数
		await bridge.sendToolInput({ arguments: args })
		// 第三份：Tool 调用结果
		await bridge.sendToolResult(result)

		appBridges.push(bridge)
	} catch (error) {
		// App 加载失败时，在原位置显示错误信息。
		const errorElement = document.createElement('div')
		errorElement.className = 'app-loading error'
		errorElement.textContent =
			error instanceof Error ? error.message : String(error)

		if (loading.isConnected) {
			loading.replaceWith(errorElement)
		} else {
			appShell.append(errorElement)
		}

		throw error
	}
}

/**
 * 按固定流程演示批量退款审核与 MCP App 报告。
 */
async function runDeterministicAppDemo() {
	// 批量退款审核只对财务身份开放，必要时先切换身份并重新连接。
	if (identityElement.value !== 'token-blue-finance') {
		identityElement.value = 'token-blue-finance'
		await startNewConversation({ reconnect: true })
	}

	appendMessage('user', '批量审核订单 A1024、A1025、A1026，并生成可视化报告。')

	// 启动后台批量审核任务。
	const startResult = await callMcpTool('start_batch_refund_review', {
		orderIds: ['A1024', 'A1025', 'A1026']
	})
	const started = extractStructuredResult(startResult)

	if (!started.ok) {
		appendMessage('assistant', started.error?.message ?? '批量审核未启动。')
		return
	}

	const jobId = started.job.jobId
	const progress = appendStatus(`任务 ${jobId} 正在后台审核……`)
	let snapshot

	// 定时查询任务状态，并更新页面中的审核进度。
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await new Promise((resolve) => window.setTimeout(resolve, 350))

		const statusResult = await requestMcpTool('get_batch_review_status', {
			jobId
		})

		snapshot = extractStructuredResult(statusResult)

		progress.lastChild.textContent =
			`任务 ${jobId}：${snapshot.job?.progress ?? 0}% ` +
			`${snapshot.job?.message ?? ''}`

		if (snapshot.job?.status === 'completed') break
	}

	progress.remove()

	if (snapshot?.job?.status !== 'completed') {
		throw new Error('批量审核等待超时')
	}

	// 任务完成后获取报告，Tool 返回的 MCP App 会加载到对话中。
	await callMcpTool('get_batch_review_report', { jobId })

	appendMessage('assistant', '批量审核已完成，MCP App 报告已经加载在对话中。')
}

async function startNewConversation({ reconnect = false } = {}) {
	setBusy(true)
	try {
		if (reconnect) await connectMcp(identityElement.value)
		messages = createConversationMessages()
		timelineElement.innerHTML = ''
		appendMessage(
			'assistant',
			`已切换为${identityLabels[identityElement.value]}。这是一段新对话，你可以开始提问。`
		)
	} catch (error) {
		setConnection(
			'error',
			error instanceof Error ? error.message : String(error)
		)
		appendMessage(
			'assistant',
			`连接失败：${error instanceof Error ? error.message : String(error)}`
		)
	} finally {
		setBusy(false)
		questionElement.focus()
	}
}

chatFormElement.addEventListener('submit', async (event) => {
	event.preventDefault()
	const question = questionElement.value.trim()
	if (!question || busy) return

	questionElement.value = ''
	setBusy(true)
	try {
		await runAgentTurn(question)
	} catch (error) {
		appendMessage(
			'assistant',
			`执行失败：${error instanceof Error ? error.message : String(error)}`
		)
	} finally {
		setBusy(false)
		questionElement.focus()
	}
})

questionElement.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault()
		chatFormElement.requestSubmit()
	}
})

questionElement.addEventListener('input', () => {
	questionElement.style.height = 'auto'
	questionElement.style.height = `${Math.min(questionElement.scrollHeight, 140)}px`
})

document.querySelectorAll('[data-prompt]').forEach((button) => {
	button.addEventListener('click', () => {
		questionElement.value = button.dataset.prompt
		questionElement.focus()
	})
})

identityElement.addEventListener('change', () =>
	startNewConversation({ reconnect: true })
)
resetButtonElement.addEventListener('click', () => startNewConversation())
acceptButtonElement.addEventListener('click', () => finishConfirmation(true))
declineButtonElement.addEventListener('click', () => finishConfirmation(false))
appDemoButtonElement.addEventListener('click', async () => {
	if (busy) return
	setBusy(true)
	try {
		await runDeterministicAppDemo()
	} catch (error) {
		appendMessage(
			'assistant',
			`MCP App 演示失败：${error instanceof Error ? error.message : String(error)}`
		)
	} finally {
		setBusy(false)
	}
})

/**
 * 初始化前端应用。
 */
async function main() {
	// 获取服务端配置，并显示当前使用的模型。
	config = await fetch('/api/config').then((response) => response.json())
	modelNameElement.textContent = config.model

	// 创建新的对话，并重新连接 MCP 服务。
	await startNewConversation({ reconnect: true })
}

await main()

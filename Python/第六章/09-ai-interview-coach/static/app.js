const state = {
	users: [],
	token: localStorage.getItem('interview-demo-token') || 'demo-linxia',
	mode: 'replay',
	capabilities: { replay: true, ai: false, model: 'deepseek-v4-flash' },
	profile: null,
	draftProfile: null,
	sessions: [],
	memories: [],
	session: null,
	editingProfile: false
}

const $ = (id) => document.getElementById(id)

const statusLabels = {
	needs_review: '待复习',
	improving: '提升中',
	mastered: '已掌握'
}

const verdictLabels = {
	correct: '回答正确',
	partial: '部分正确',
	incorrect: '需要复习'
}

function escapeHtml(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

async function request(path, token, init = {}) {
	const response = await fetch(`/api${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { 'x-demo-token': token } : {}),
			...(init.headers || {})
		}
	})
	const result = await response.json().catch(() => null)

	if (!response.ok) {
		throw new Error(result?.detail || result?.message || `请求失败：HTTP ${response.status}`)
	}

	return result
}

const api = {
	users: () => request('/users'),
	capabilities: (token) => request('/capabilities', token),
	profile: (token) => request('/profile', token),
	updateProfile: (token, profile) =>
		request('/profile', token, {
			method: 'PATCH',
			body: JSON.stringify(profile)
		}),
	memories: (token) => request('/memories', token),
	deleteMemory: (token, key) =>
		request(`/memories/${encodeURIComponent(key)}`, token, { method: 'DELETE' }),
	sessions: (token) => request('/sessions', token),
	createSession: (token, input) =>
		request('/sessions', token, {
			method: 'POST',
			body: JSON.stringify(input)
		}),
	session: (token, id) => request(`/sessions/${id}`, token),
	answer: (token, id, answer) =>
		request(`/sessions/${id}/answers`, token, {
			method: 'POST',
			body: JSON.stringify({ answer })
		}),
	next: (token, id) => request(`/sessions/${id}/next`, token, { method: 'POST' })
}

function currentUser() {
	return state.users.find((item) => item.token === state.token)
}

function weakCount() {
	return state.memories.filter((item) => item.status !== 'mastered').length
}

function cloneProfile(profile) {
	return {
		...profile,
		focusTopics: [...profile.focusTopics]
	}
}

function suggestedAnswers() {
	if (state.session?.currentQuestion?.topic === 'agent-memory') {
		return {
			weak: '它们都是保存聊天记录的，只是保存位置不同。',
			complete:
				'Checkpointer 按 thread_id 保存当前会话的 State；Store 使用 tenantId 和 userId 组成的 Namespace 保存跨会话信息。因此，新 Thread 也需要读取的薄弱知识点应该写入 Store。'
		}
	}

	return {
		weak: '模型会根据问题自己找资料。',
		complete:
			'Agent 会先判断当前任务是否需要检索，再根据必要证据类型查询资料。当已召回证据仍无法支持完整回答时，才继续补查，并使用检索预算避免无限循环。'
	}
}

async function run(task) {
	$('loading').classList.remove('hidden')
	$('error').classList.add('hidden')

	try {
		await task()
	} catch (error) {
		$('error').textContent = error instanceof Error ? error.message : '操作失败。'
		$('error').classList.remove('hidden')
	} finally {
		$('loading').classList.add('hidden')
		render()
	}
}

async function refreshSidebar() {
	const [capabilities, profile, sessions, memories] = await Promise.all([
		api.capabilities(state.token),
		api.profile(state.token),
		api.sessions(state.token),
		api.memories(state.token)
	])

	state.capabilities = capabilities
	state.profile = profile
	state.draftProfile = cloneProfile(profile)
	state.sessions = sessions
	state.memories = memories

	if (!capabilities.ai) {
		state.mode = 'replay'
	}
}

async function switchUser() {
	localStorage.setItem('interview-demo-token', state.token)
	state.session = null
	await run(refreshSidebar)
}

async function createSession(kind) {
	await run(async () => {
		state.session = await api.createSession(state.token, {
			kind,
			mode: state.mode
		})
		$('answer').value = ''
		await refreshSidebar()
		scrollToBottom()
	})
}

async function openSession(id) {
	await run(async () => {
		state.session = await api.session(state.token, id)
		$('answer').value = ''
		scrollToBottom()
	})
}

async function submitAnswer() {
	const answer = $('answer').value.trim()

	if (!state.session || state.session.status !== 'awaiting_answer' || !answer) {
		return
	}

	await run(async () => {
		state.session = await api.answer(state.token, state.session.sessionId, answer)
		$('answer').value = ''
		await refreshSidebar()
		scrollToBottom()
	})
}

async function nextQuestion() {
	if (!state.session) return

	await run(async () => {
		state.session = await api.next(state.token, state.session.sessionId)
		await refreshSidebar()
		scrollToBottom()
	})
}

async function saveProfile() {
	if (!state.draftProfile) return

	await run(async () => {
		state.profile = await api.updateProfile(state.token, state.draftProfile)
		state.draftProfile = cloneProfile(state.profile)
		state.editingProfile = false
	})
}

async function deleteMemory(key) {
	await run(async () => {
		await api.deleteMemory(state.token, key)
		state.memories = await api.memories(state.token)
	})
}

function scrollToBottom() {
	requestAnimationFrame(() => {
		$('chat').scrollTop = $('chat').scrollHeight
	})
}

function renderUsers() {
	$('user').innerHTML = state.users
		.map(
			(user) =>
				`<option value="${escapeHtml(user.token)}" ${user.token === state.token ? 'selected' : ''}>${escapeHtml(user.name)}</option>`
		)
		.join('')
}

function renderMode() {
	$('modeReplay').classList.toggle('active', state.mode === 'replay')
	$('modeAi').classList.toggle('active', state.mode === 'ai')
	$('modeAi').disabled = !state.capabilities.ai
	$('modeAi').title = state.capabilities.ai
		? state.capabilities.model
		: '未配置 DeepSeek API Key'
}

function renderSessions() {
	if (!state.sessions.length) {
		$('sessionList').innerHTML = '<p class="empty-copy">还没有面试记录</p>'
		return
	}

	$('sessionList').innerHTML = state.sessions
		.map(
			(item) => `
			<button class="session-item ${state.session?.sessionId === item.id ? 'selected' : ''}" data-session-id="${escapeHtml(item.id)}">
				<span class="session-icon">💬</span>
				<span class="session-copy">
					<strong>${escapeHtml(item.title)}</strong>
					<small>${escapeHtml(item.topic)} · ${item.turnNumber} 轮</small>
				</span>
				<span>›</span>
			</button>
		`
		)
		.join('')
}

function renderProfile() {
	if (!state.profile || !state.draftProfile) {
		$('profileView').innerHTML = ''
		return
	}

	$('profileView').classList.toggle('hidden', state.editingProfile)
	$('profileEditor').classList.toggle('hidden', !state.editingProfile)

	$('profileView').innerHTML = `
		<strong>${escapeHtml(state.profile.targetRole)}</strong>
		<p>${escapeHtml(state.profile.experience)}</p>
		<div class="tag-row">
			${state.profile.focusTopics.map((topic) => `<span>${escapeHtml(topic)}</span>`).join('')}
		</div>
	`

	$('profileRole').value = state.draftProfile.targetRole
	$('profileExperience').value = state.draftProfile.experience
	$('profileTopics').value = state.draftProfile.focusTopics.join('、')
	$('profileStyle').value = state.draftProfile.answerStyle
}

function renderMemories() {
	const count = state.memories.length
	$('memoryCount').textContent = `${count} 条`
	const weak = weakCount()
	$('weakCount').textContent = weak
	$('weakCount').classList.toggle('hidden', weak === 0)
	$('reviewSession').disabled = weak === 0

	if (!count) {
		$('memoryList').innerHTML = '<p class="empty-copy">完成第一题后，训练结果会保存在这里。</p>'
		return
	}

	$('memoryList').innerHTML = state.memories
		.map(
			(item) => `
			<article class="memory-item">
				<div class="memory-topline">
					<strong>${escapeHtml(item.title)}</strong>
					<span class="memory-status ${escapeHtml(item.status)}">${statusLabels[item.status]}</span>
				</div>
				<p>${escapeHtml(item.lastAnswerSummary)}</p>
				<div class="memory-footer">
					<span>${item.correctCount}/${item.attempts} 次正确</span>
					<button title="删除并停止自动记忆该主题" data-memory-key="${escapeHtml(item.key)}">🗑</button>
				</div>
			</article>
		`
		)
		.join('')
}

function renderSession() {
	if (!state.session) {
		$('panelTitle').textContent = '准备开始一场面试'
		$('sessionBadge').classList.add('hidden')
		$('welcome').classList.remove('hidden')
		$('sessionArea').classList.add('hidden')
		$('sessionInspector').classList.add('hidden')
		return
	}

	const session = state.session
	const round =
		session.status === 'awaiting_answer'
			? session.turnNumber + 1
			: session.turnNumber

	$('panelTitle').textContent = session.currentQuestion?.title || '准备开始一场面试'
	$('sessionBadge').textContent = `第 ${round} 轮`
	$('sessionBadge').classList.remove('hidden')
	$('welcome').classList.add('hidden')
	$('sessionArea').classList.remove('hidden')
	$('sessionInspector').classList.remove('hidden')

	$('chat').innerHTML = session.messages
		.map(
			(item) => `
			<div class="message-row ${escapeHtml(item.role)} ${escapeHtml(item.kind)}">
				<div class="avatar">${item.role === 'user' ? '👤' : '🧠'}</div>
				<div class="message-body">
					<div class="message-meta">
						<strong>${item.role === 'user' ? escapeHtml(currentUser()?.name) : '面试教练'}</strong>
						${item.kind === 'feedback' ? '<span>面试反馈</span>' : ''}
					</div>
					<p>${escapeHtml(item.content)}</p>
				</div>
			</div>
		`
		)
		.join('')

	const awaiting = session.status === 'awaiting_answer'
	$('composer').classList.toggle('hidden', !awaiting)
	$('turnResult').classList.toggle('hidden', awaiting)

	if (session.lastEvaluation) {
		$('verdict').className = `verdict ${session.lastEvaluation.verdict}`
		$('verdict').textContent = verdictLabels[session.lastEvaluation.verdict]
	}

	$('sourceCount').textContent = `${session.evidence.length} 条`
	$('sourceList').innerHTML = session.evidence
		.map(
			(source) => `
			<a class="source-item" href="${escapeHtml(source.url)}" target="_blank">
				<strong>${escapeHtml(source.title)}</strong>
				<span>${escapeHtml(source.id)}</span>
			</a>
		`
		)
		.join('')

	const trace = session.trace || []
	$('traceBlock').classList.toggle('hidden', trace.length === 0)
	$('traceList').innerHTML = trace
		.slice(-6)
		.map((item) => `<li>${escapeHtml(item)}</li>`)
		.join('')
}

function render() {
	renderUsers()
	renderMode()
	renderSessions()
	renderProfile()
	renderMemories()
	renderSession()
}

function bindEvents() {
	$('user').addEventListener('change', (event) => {
		state.token = event.target.value
		switchUser()
	})

	$('modeReplay').addEventListener('click', () => {
		state.mode = 'replay'
		renderMode()
	})

	$('modeAi').addEventListener('click', () => {
		if (state.capabilities.ai) {
			state.mode = 'ai'
			renderMode()
		}
	})

	$('newSession').addEventListener('click', () => createSession('new'))
	$('reviewSession').addEventListener('click', () => createSession('review'))
	$('welcomeStart').addEventListener('click', () => createSession('new'))
	$('submitAnswer').addEventListener('click', submitAnswer)
	$('nextQuestion').addEventListener('click', nextQuestion)

	$('weakAnswer').addEventListener('click', () => {
		$('answer').value = suggestedAnswers().weak
	})

	$('completeAnswer').addEventListener('click', () => {
		$('answer').value = suggestedAnswers().complete
	})

	$('answer').addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			submitAnswer()
		}
	})

	$('editProfile').addEventListener('click', () => {
		state.editingProfile = !state.editingProfile
		renderProfile()
	})

	$('saveProfile').addEventListener('click', () => {
		state.draftProfile = {
			targetRole: $('profileRole').value,
			experience: $('profileExperience').value,
			focusTopics: $('profileTopics').value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean),
			answerStyle: $('profileStyle').value
		}
		saveProfile()
	})

	$('sessionList').addEventListener('click', (event) => {
		const button = event.target.closest('[data-session-id]')
		if (button) openSession(button.dataset.sessionId)
	})

	$('memoryList').addEventListener('click', (event) => {
		const button = event.target.closest('[data-memory-key]')
		if (button) deleteMemory(button.dataset.memoryKey)
	})
}

async function bootstrap() {
	bindEvents()

	await run(async () => {
		state.users = await api.users()

		if (!state.users.some((item) => item.token === state.token)) {
			state.token = state.users[0]?.token || 'demo-linxia'
		}

		await refreshSidebar()
	})
}

bootstrap()

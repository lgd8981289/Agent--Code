<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import {
	Activity,
	BookOpen,
	BrainCircuit,
	CheckCircle2,
	ChevronRight,
	Clock3,
	Database,
	History,
	MessageSquareText,
	Play,
	RefreshCw,
	Save,
	Send,
	Settings2,
	Target,
	Trash2,
	UserRound
} from '@lucide/vue'
import { api } from './api'
import type {
	Capabilities,
	DemoUser,
	InterviewState,
	LearningMemory,
	Profile,
	SessionSummary
} from './types'

const users = ref<DemoUser[]>([])
const token = ref(localStorage.getItem('interview-demo-token') ?? 'demo-linxia')
const capabilities = ref<Capabilities>({
	replay: true,
	ai: false,
	model: 'deepseek-v4-flash'
})
const mode = ref<'replay' | 'ai'>('replay')
const sessions = ref<SessionSummary[]>([])
const memories = ref<LearningMemory[]>([])
const profile = ref<Profile | null>(null)
const draftProfile = ref<Profile | null>(null)
const session = ref<InterviewState | null>(null)
const answer = ref('')
const loading = ref(false)
const error = ref('')
const editingProfile = ref(false)
const chat = ref<HTMLElement | null>(null)

const currentUser = computed(() =>
	users.value.find((item) => item.token === token.value)
)
const weakCount = computed(
	() => memories.value.filter((item) => item.status !== 'mastered').length
)
const canSubmit = computed(
	() =>
		session.value?.status === 'awaiting_answer' &&
		answer.value.trim().length > 0
)

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

/** 将画像复制成普通对象，避免直接克隆 Vue 创建的响应式 Proxy。 */
function cloneProfile(value: Profile): Profile {
	return {
		...value,
		focusTopics: [...value.focusTopics]
	}
}

const suggestedAnswers = computed(() => {
	if (session.value?.currentQuestion?.topic === 'agent-memory') {
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
})

async function run(task: () => Promise<void>) {
	loading.value = true
	error.value = ''
	try {
		await task()
	} catch (caught) {
		error.value = caught instanceof Error ? caught.message : '操作失败。'
	} finally {
		loading.value = false
	}
}

async function refreshSidebar() {
	const [nextCapabilities, nextProfile, nextSessions, nextMemories] =
		await Promise.all([
			api.capabilities(token.value),
			api.profile(token.value),
			api.sessions(token.value),
			api.memories(token.value)
		])
	capabilities.value = nextCapabilities
	profile.value = nextProfile
	draftProfile.value = cloneProfile(nextProfile)
	sessions.value = nextSessions
	memories.value = nextMemories
	if (!nextCapabilities.ai) mode.value = 'replay'
}

async function switchUser() {
	localStorage.setItem('interview-demo-token', token.value)
	session.value = null
	await run(refreshSidebar)
}

/**
 * 开始面试按钮的点击事件
 */
async function createSession(kind: 'new' | 'review') {
	await run(async () => {
		session.value = await api.createSession(token.value, {
			kind,
			mode: mode.value
		})
		answer.value = ''
		await refreshSidebar()
		await scrollToBottom()
	})
}

async function openSession(id: string) {
	await run(async () => {
		session.value = await api.session(token.value, id)
		answer.value = ''
		await scrollToBottom()
	})
}

async function submitAnswer() {
	if (!session.value || !canSubmit.value) return
	await run(async () => {
		session.value = await api.answer(
			token.value,
			session.value!.sessionId,
			answer.value
		)
		answer.value = ''
		await refreshSidebar()
		await scrollToBottom()
	})
}

async function nextQuestion() {
	if (!session.value) return
	await run(async () => {
		session.value = await api.next(token.value, session.value!.sessionId)
		await refreshSidebar()
		await scrollToBottom()
	})
}

async function saveProfile() {
	if (!draftProfile.value) return
	await run(async () => {
		profile.value = await api.updateProfile(token.value, draftProfile.value!)
		draftProfile.value = cloneProfile(profile.value)
		editingProfile.value = false
	})
}

async function deleteMemory(key: string) {
	await run(async () => {
		await api.deleteMemory(token.value, key)
		memories.value = await api.memories(token.value)
	})
}

async function scrollToBottom() {
	await nextTick()
	if (chat.value) chat.value.scrollTop = chat.value.scrollHeight
}

onMounted(() =>
	run(async () => {
		users.value = await api.users()
		if (!users.value.some((item) => item.token === token.value)) {
			token.value = users.value[0]?.token ?? 'demo-linxia'
		}
		await refreshSidebar()
	})
)
</script>

<template>
	<div class="app-shell">
		<header class="topbar">
			<div class="brand">
				<div class="brand-mark"><BrainCircuit :size="21" /></div>
				<div>
					<strong>AI 面试教练</strong>
					<span>Memory Lab</span>
				</div>
			</div>
			<div class="topbar-status">
				<span class="status-dot"></span>
				PostgreSQL 持久化已连接
			</div>
		</header>

		<main class="workspace">
			<aside class="sidebar">
				<label class="field-label" for="user">当前候选人</label>
				<div class="user-select">
					<UserRound :size="17" />
					<select id="user" v-model="token" @change="switchUser">
						<option
							v-for="user in users"
							:key="user.userId"
							:value="user.token"
						>
							{{ user.name }}
						</option>
					</select>
				</div>

				<div class="mode-control" aria-label="运行模式">
					<button
						:class="{ active: mode === 'replay' }"
						@click="mode = 'replay'"
					>
						Replay
					</button>
					<button
						:class="{ active: mode === 'ai' }"
						:disabled="!capabilities.ai"
						:title="
							capabilities.ai ? capabilities.model : '未配置 DeepSeek API Key'
						"
						@click="mode = 'ai'"
					>
						AI
					</button>
				</div>

				<button
					class="primary-action"
					:disabled="loading"
					@click="createSession('new')"
				>
					<Play :size="17" />
					开始专项面试
				</button>
				<button
					class="secondary-action"
					:disabled="loading || weakCount === 0"
					@click="createSession('review')"
				>
					<RefreshCw :size="17" />
					复习薄弱点
					<span v-if="weakCount" class="count">{{ weakCount }}</span>
				</button>

				<div class="section-heading">
					<span>历史面试</span>
					<History :size="15" />
				</div>
				<div class="session-list">
					<button
						v-for="item in sessions"
						:key="item.id"
						class="session-item"
						:class="{ selected: session?.sessionId === item.id }"
						@click="openSession(item.id)"
					>
						<span class="session-icon"><MessageSquareText :size="16" /></span>
						<span class="session-copy">
							<strong>{{ item.title }}</strong>
							<small>{{ item.topic }} · {{ item.turnNumber }} 轮</small>
						</span>
						<ChevronRight :size="15" />
					</button>
					<p v-if="sessions.length === 0" class="empty-copy">还没有面试记录</p>
				</div>
			</aside>

			<section class="interview-panel">
				<div class="panel-header">
					<div>
						<span class="eyebrow">INTERVIEW SESSION</span>
						<h1>{{ session?.currentQuestion?.title ?? '准备开始一场面试' }}</h1>
					</div>
					<span v-if="session" class="session-badge">
						<Clock3 :size="14" /> 第
						{{
							session.status === 'awaiting_answer'
								? session.turnNumber + 1
								: session.turnNumber
						}}
						轮
					</span>
				</div>

				<div v-if="error" class="error-banner">{{ error }}</div>

				<div v-if="!session" class="welcome-state">
					<div class="welcome-icon"><Target :size="30" /></div>
					<h2>用一场真实的面试，验证 Agent Memory</h2>
					<p>系统会记住你的面试进度和薄弱点，并在新会话中生成针对性复测。</p>
					<button class="primary-action compact" @click="createSession('new')">
						<Play :size="17" />开始面试
					</button>
				</div>

				<template v-else>
					<div ref="chat" class="chat-stream">
						<div
							v-for="item in session.messages"
							:key="item.id"
							class="message-row"
							:class="[item.role, item.kind]"
						>
							<div class="avatar">
								<UserRound v-if="item.role === 'user'" :size="16" />
								<BrainCircuit v-else :size="16" />
							</div>
							<div class="message-body">
								<div class="message-meta">
									<strong>{{
										item.role === 'user' ? currentUser?.name : '面试教练'
									}}</strong>
									<span v-if="item.kind === 'feedback'">面试反馈</span>
								</div>
								<p>{{ item.content }}</p>
							</div>
						</div>
					</div>

					<div v-if="session.status === 'awaiting_answer'" class="composer">
						<div class="answer-shortcuts">
							<button @click="answer = suggestedAnswers.weak">
								填入不完整回答
							</button>
							<button @click="answer = suggestedAnswers.complete">
								填入完整回答
							</button>
						</div>
						<textarea
							v-model="answer"
							rows="4"
							placeholder="输入你的回答…"
							@keydown.meta.enter="submitAnswer"
							@keydown.ctrl.enter="submitAnswer"
						></textarea>
						<div class="composer-footer">
							<span>Ctrl / Cmd + Enter 提交</span>
							<button
								class="send-button"
								:disabled="!canSubmit || loading"
								@click="submitAnswer"
							>
								<Send :size="16" />提交回答
							</button>
						</div>
					</div>

					<div v-else class="turn-result">
						<div
							v-if="session.lastEvaluation"
							class="verdict"
							:class="session.lastEvaluation.verdict"
						>
							<CheckCircle2 :size="18" />
							{{ verdictLabels[session.lastEvaluation.verdict] }}
						</div>
						<button
							class="primary-action compact"
							:disabled="loading"
							@click="nextQuestion"
						>
							继续下一题 <ChevronRight :size="17" />
						</button>
					</div>
				</template>
			</section>

			<aside class="inspector">
				<section class="inspector-section">
					<div class="section-heading large">
						<span><UserRound :size="16" />面试画像</span>
						<button
							class="icon-button"
							title="编辑面试画像"
							@click="editingProfile = !editingProfile"
						>
							<Settings2 :size="16" />
						</button>
					</div>
					<div v-if="draftProfile" class="profile-content">
						<template v-if="editingProfile">
							<label>目标岗位<input v-model="draftProfile.targetRole" /></label>
							<label>开发经验<input v-model="draftProfile.experience" /></label>
							<label
								>专项方向<input
									:value="draftProfile.focusTopics.join('、')"
									@input="
										draftProfile.focusTopics = (
											$event.target as HTMLInputElement
										).value
											.split(/[,，、]/)
											.filter(Boolean)
									"
							/></label>
							<button class="save-button" @click="saveProfile">
								<Save :size="15" />保存画像
							</button>
						</template>
						<template v-else>
							<strong>{{ profile?.targetRole }}</strong>
							<p>{{ profile?.experience }}</p>
							<div class="tag-row">
								<span v-for="topic in profile?.focusTopics" :key="topic">{{
									topic
								}}</span>
							</div>
						</template>
					</div>
				</section>

				<section class="inspector-section grow">
					<div class="section-heading large">
						<span><Database :size="16" />训练记忆</span>
						<small>{{ memories.length }} 条</small>
					</div>
					<div class="memory-list">
						<article
							v-for="item in memories"
							:key="item.key"
							class="memory-item"
						>
							<div class="memory-topline">
								<strong>{{ item.title }}</strong>
								<span :class="['memory-status', item.status]">{{
									statusLabels[item.status]
								}}</span>
							</div>
							<p>{{ item.lastAnswerSummary }}</p>
							<div class="memory-footer">
								<span>{{ item.correctCount }}/{{ item.attempts }} 次正确</span>
								<button
									title="删除并停止自动记忆该主题"
									@click="deleteMemory(item.key)"
								>
									<Trash2 :size="15" />
								</button>
							</div>
						</article>
						<p v-if="memories.length === 0" class="empty-copy">
							完成第一题后，训练结果会保存在这里。
						</p>
					</div>
				</section>

				<section v-if="session" class="inspector-section">
					<div class="section-heading large">
						<span><BookOpen :size="16" />本轮依据</span>
						<small>{{ session.evidence.length }} 条</small>
					</div>
					<a
						v-for="source in session.evidence"
						:key="source.id"
						:href="source.url"
						target="_blank"
						class="source-item"
					>
						<strong>{{ source.title }}</strong>
						<span>{{ source.id }}</span>
					</a>
					<div v-if="session.trace.length" class="trace-block">
						<div class="trace-title"><Activity :size="15" />Graph 轨迹</div>
						<ol>
							<li v-for="(item, index) in session.trace.slice(-6)" :key="index">
								{{ item }}
							</li>
						</ol>
					</div>
				</section>
			</aside>
		</main>

		<div v-if="loading" class="loading-bar"></div>
	</div>
</template>

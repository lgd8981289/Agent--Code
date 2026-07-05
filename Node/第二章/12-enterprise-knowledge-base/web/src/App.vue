<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
	BookOpenText,
	Bot,
	Building2,
	CheckCircle2,
	ChevronDown,
	CircleAlert,
	Clock3,
	Database,
	FilePlus2,
	FileText,
	Globe2,
	Layers3,
	LoaderCircle,
	LockKeyhole,
	RefreshCw,
	Search,
	SendHorizontal,
	ShieldCheck,
	Sparkles,
	Upload,
	Users,
	X
} from '@lucide/vue'
import {
	getDocuments,
	getHealth,
	getUsers,
	queryKnowledge,
	saveDocument
} from './api'
import type { DemoUser, DocumentSummary, QueryResult } from './types'

type DocumentFilter = 'all' | 'company' | 'department'
type MobileView = 'query' | 'documents'

const users = ref<DemoUser[]>([])
const activeToken = ref('')
const documents = ref<DocumentSummary[]>([])
const serverOnline = ref(false)
const loadingDocuments = ref(false)
const question = ref('3000 元退款需要人工审核吗？')
const lastQuestion = ref('')
const asking = ref(false)
const result = ref<QueryResult | null>(null)
const error = ref('')
const documentSearch = ref('')
const documentFilter = ref<DocumentFilter>('all')
const mobileView = ref<MobileView>('query')

const showDocumentModal = ref(false)
const savingDocument = ref(false)
const editingDocument = ref<DocumentSummary | null>(null)
const documentTitle = ref('')
const departmentId = ref('customer-service')
const visibility = ref<'company' | 'department'>('company')
const selectedFile = ref<File | null>(null)
const saveMessage = ref('')

const suggestions = [
	'退款金额 3500 元，会触发人工审核吗？',
	'BW-RF-2026 对应什么规则？',
	'退款审核通过以后多久到账？'
]

const activeUser = computed(() =>
	users.value.find((user) => user.token === activeToken.value)
)
const isAdmin = computed(() => activeUser.value?.role === 'admin')
const companyDocumentCount = computed(
	() => documents.value.filter((item) => item.visibility === 'company').length
)
const departmentDocumentCount = computed(
	() => documents.value.filter((item) => item.visibility === 'department').length
)
const filteredDocuments = computed(() => {
	const keyword = documentSearch.value.trim().toLowerCase()
	return documents.value.filter((document) => {
		const matchedFilter =
			documentFilter.value === 'all' ||
			document.visibility === documentFilter.value
		const matchedKeyword =
			!keyword ||
			document.title.toLowerCase().includes(keyword) ||
			document.departmentId.toLowerCase().includes(keyword)
		return matchedFilter && matchedKeyword
	})
})

onMounted(async () => {
	try {
		const [userList] = await Promise.all([getUsers(), checkHealth()])
		users.value = userList
		activeToken.value = userList[0]?.token ?? ''
		await loadDocuments()
	} catch (reason) {
		setError(reason)
	}
})

async function checkHealth() {
	try {
		serverOnline.value = (await getHealth()).status === 'ok'
	} catch {
		serverOnline.value = false
	}
}

async function changeUser() {
	result.value = null
	lastQuestion.value = ''
	error.value = ''
	await loadDocuments()
}

async function loadDocuments() {
	if (!activeToken.value) return
	loadingDocuments.value = true
	try {
		documents.value = await getDocuments(activeToken.value)
	} catch (reason) {
		setError(reason)
	} finally {
		loadingDocuments.value = false
	}
}

async function ask(prefilledQuestion?: string) {
	const submittedQuestion = (prefilledQuestion ?? question.value).trim()
	if (!submittedQuestion || !activeToken.value) return

	question.value = submittedQuestion
	lastQuestion.value = submittedQuestion
	asking.value = true
	error.value = ''
	result.value = null
	try {
		result.value = await queryKnowledge(activeToken.value, submittedQuestion)
	} catch (reason) {
		setError(reason)
	} finally {
		asking.value = false
	}
}

function openCreate() {
	editingDocument.value = null
	documentTitle.value = ''
	departmentId.value = 'customer-service'
	visibility.value = 'company'
	selectedFile.value = null
	saveMessage.value = ''
	showDocumentModal.value = true
}

function openUpdate(document: DocumentSummary) {
	editingDocument.value = document
	documentTitle.value = document.title
	departmentId.value = document.departmentId
	visibility.value = document.visibility
	selectedFile.value = null
	saveMessage.value = ''
	showDocumentModal.value = true
}

function chooseFile(event: Event) {
	selectedFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function submitDocument() {
	if (!activeUser.value || !selectedFile.value || !documentTitle.value.trim()) return
	savingDocument.value = true
	saveMessage.value = ''
	try {
		const response = await saveDocument({
			token: activeUser.value.token,
			file: selectedFile.value,
			title: documentTitle.value.trim(),
			departmentId: departmentId.value.trim(),
			visibility: visibility.value,
			documentId: editingDocument.value?.documentId
		})
		saveMessage.value =
			response.status === 'skipped'
				? response.reason || '文档没有变化。'
				: `文档已保存为 v${response.document.version}`
		await loadDocuments()
		if (response.status !== 'skipped') {
			setTimeout(() => (showDocumentModal.value = false), 700)
		}
	} catch (reason) {
		saveMessage.value = reason instanceof Error ? reason.message : String(reason)
	} finally {
		savingDocument.value = false
	}
}

function setError(reason: unknown) {
	error.value = reason instanceof Error ? reason.message : String(reason)
}

function formatDate(timestamp: number) {
	return new Intl.DateTimeFormat('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	}).format(timestamp)
}
</script>

<template>
	<div class="app-shell">
		<header class="topbar">
			<div class="brand">
				<div class="brand-mark"><BookOpenText :size="20" /></div>
				<div class="brand-copy">
					<strong>Knowledge Hub</strong>
					<span>企业知识中台</span>
				</div>
			</div>

			<div class="breadcrumb" v-if="activeUser">
				<span>{{ activeUser.tenantName }}</span>
				<i>/</i>
				<strong>知识库工作台</strong>
			</div>

			<div class="topbar-actions">
				<div class="health" :class="{ offline: !serverOnline }">
					<span></span>{{ serverOnline ? '运行中' : '服务离线' }}
				</div>
				<label class="identity-select">
					<div class="identity-avatar">{{ activeUser?.name.slice(0, 1) || 'U' }}</div>
					<div class="identity-copy">
						<strong>{{ activeUser?.name || '选择身份' }}</strong>
						<span>{{ activeUser?.departmentName }}</span>
					</div>
					<select v-model="activeToken" aria-label="切换演示身份" @change="changeUser">
						<option v-for="user in users" :key="user.token" :value="user.token">
							{{ user.tenantName }} · {{ user.name }} · {{ user.departmentName }}
						</option>
					</select>
					<ChevronDown :size="15" />
				</label>
			</div>
		</header>

		<div v-if="error" class="error-banner">
			<CircleAlert :size="17" />
			<span>{{ error }}</span>
			<button aria-label="关闭错误" @click="error = ''"><X :size="16" /></button>
		</div>

		<nav class="mobile-tabs" aria-label="移动端视图切换">
			<button :class="{ active: mobileView === 'query' }" @click="mobileView = 'query'">
				<Bot :size="16" />问答
			</button>
			<button :class="{ active: mobileView === 'documents' }" @click="mobileView = 'documents'">
				<Database :size="16" />文档
			</button>
		</nav>

		<main class="workspace">
			<aside class="library-panel" :class="{ 'mobile-hidden': mobileView !== 'documents' }">
				<div class="library-heading">
					<div>
						<span class="section-kicker">KNOWLEDGE BASE</span>
						<h1>知识库</h1>
					</div>
					<div class="heading-actions">
						<button class="icon-button" title="刷新文档" @click="loadDocuments">
							<RefreshCw :size="16" :class="{ spinning: loadingDocuments }" />
						</button>
						<button v-if="isAdmin" class="primary-button compact" @click="openCreate">
							<FilePlus2 :size="16" />新建
						</button>
					</div>
				</div>

				<div class="library-stats">
					<div><strong>{{ documents.length }}</strong><span>可访问</span></div>
					<div><strong>{{ companyDocumentCount }}</strong><span>企业公开</span></div>
					<div><strong>{{ departmentDocumentCount }}</strong><span>部门文档</span></div>
				</div>

				<label class="document-search">
					<Search :size="16" />
					<input v-model="documentSearch" placeholder="搜索文档或部门" />
				</label>

				<div class="filter-tabs">
					<button :class="{ active: documentFilter === 'all' }" @click="documentFilter = 'all'">全部</button>
					<button :class="{ active: documentFilter === 'company' }" @click="documentFilter = 'company'">企业</button>
					<button :class="{ active: documentFilter === 'department' }" @click="documentFilter = 'department'">部门</button>
				</div>

				<div v-if="loadingDocuments" class="panel-loading">
					<LoaderCircle :size="22" class="spinning" />
				</div>
				<div v-else-if="filteredDocuments.length === 0" class="empty-library">
					<FileText :size="25" />
					<span>暂无匹配文档</span>
				</div>
				<div v-else class="document-list">
					<article v-for="document in filteredDocuments" :key="document.documentId" class="document-row">
						<div class="document-icon">
							<Globe2 v-if="document.visibility === 'company'" :size="17" />
							<LockKeyhole v-else :size="17" />
						</div>
						<div class="document-info">
							<h2>{{ document.title }}</h2>
							<div class="document-meta">
								<span>v{{ document.version }}</span>
								<span>{{ document.chunkCount }} chunks</span>
								<span>{{ document.visibility === 'company' ? '全员可见' : document.departmentId }}</span>
							</div>
							<time><Clock3 :size="12" />{{ formatDate(document.updatedAt) }}</time>
						</div>
						<button
							v-if="isAdmin"
							class="icon-button row-action"
							title="发布新版本"
							@click="openUpdate(document)"
						>
							<Upload :size="15" />
						</button>
					</article>
				</div>
			</aside>

			<section class="query-panel" :class="{ 'mobile-hidden': mobileView !== 'query' }">
				<div class="query-heading">
					<div>
						<span class="section-kicker">AI RETRIEVAL</span>
						<h1>知识问答</h1>
					</div>
					<div class="pipeline-labels">
						<span><Layers3 :size="14" />Hybrid Search</span>
						<span><Sparkles :size="14" />Rerank</span>
						<span><ShieldCheck :size="14" />{{ activeUser?.role === 'admin' ? '管理员权限' : activeUser?.departmentName }}</span>
					</div>
				</div>

				<div class="conversation">
					<div v-if="asking || lastQuestion" class="user-question">
						<div class="message-avatar user">{{ activeUser?.name.slice(0, 1) }}</div>
						<div>
							<span>{{ activeUser?.name }}</span>
							<p>{{ lastQuestion }}</p>
						</div>
					</div>

					<div v-if="asking" class="assistant-response loading-response">
						<div class="message-avatar assistant"><Bot :size="17" /></div>
						<div>
							<span>知识库助手</span>
							<p><LoaderCircle :size="16" class="spinning" />正在检索并核对企业知识</p>
						</div>
					</div>

					<div v-else-if="!result" class="query-empty">
						<div class="empty-symbol"><Bot :size="27" /></div>
						<h2>从企业知识中查找答案</h2>
						<div class="suggestion-list">
							<button v-for="item in suggestions" :key="item" @click="ask(item)">
								<span>{{ item }}</span><SendHorizontal :size="14" />
							</button>
						</div>
					</div>

					<div v-else class="assistant-response result-response">
						<div class="message-avatar assistant"><Bot :size="17" /></div>
						<div class="response-content">
							<div class="message-heading">
								<div><strong>知识库助手</strong><span>{{ result.pipeline.latencyMs }} ms</span></div>
								<div class="answer-status" :class="result.status">
									<CheckCircle2 v-if="result.status === 'answered'" :size="15" />
									<CircleAlert v-else :size="15" />
									{{ result.status === 'answered' ? '依据充分' : '依据不足' }}
								</div>
							</div>

							<div class="answer-copy">{{ result.answer }}</div>

							<section v-if="result.sources.length" class="sources-section">
								<div class="subsection-heading">
									<strong>引用来源</strong><span>{{ result.sources.length }}</span>
								</div>
								<article v-for="source in result.sources" :key="source.chunkId" class="source-row">
									<div class="source-index">{{ source.chunkIndex + 1 }}</div>
									<div>
										<div class="source-title">
											<strong>{{ source.title }}</strong>
											<span>v{{ source.version }} · Chunk {{ source.chunkIndex + 1 }}</span>
										</div>
										<p>{{ source.content }}</p>
										<code>{{ source.chunkId }}</code>
									</div>
								</article>
							</section>

							<details class="pipeline-details">
								<summary>
									<span><Database :size="14" />检索链路</span>
									<b>{{ result.pipeline.recalledCount }} 召回 · {{ result.pipeline.rerankedCount }} 精排</b>
								</summary>
								<div class="filter-code">{{ result.pipeline.permissionFilter }}</div>
								<div v-for="candidate in result.pipeline.candidates" :key="candidate.chunkId" class="candidate-row">
									<div><span>#{{ candidate.rank }}</span><strong>{{ candidate.title }}</strong></div>
									<b>{{ candidate.rerankScore.toFixed(4) }}</b>
								</div>
							</details>
						</div>
					</div>
				</div>

				<div class="composer-wrap">
					<form class="composer" @submit.prevent="ask()">
						<textarea v-model="question" rows="2" maxlength="1000" placeholder="输入需要查询的企业知识问题"></textarea>
						<div class="composer-footer">
							<span>{{ question.length }} / 1000</span>
							<button class="send-button" :disabled="asking || !question.trim()" aria-label="发送问题">
								<LoaderCircle v-if="asking" :size="17" class="spinning" />
								<SendHorizontal v-else :size="17" />
							</button>
						</div>
					</form>
				</div>
			</section>
		</main>

		<div v-if="showDocumentModal" class="modal-backdrop" @click.self="showDocumentModal = false">
			<form class="modal" @submit.prevent="submitDocument">
				<div class="modal-heading">
					<div>
						<span class="section-kicker">DOCUMENT VERSION</span>
						<h2>{{ editingDocument ? '发布文档新版本' : '新建知识文档' }}</h2>
					</div>
					<button type="button" class="icon-button" aria-label="关闭" @click="showDocumentModal = false"><X :size="18" /></button>
				</div>

				<div class="form-grid">
					<label class="wide">文档标题<input v-model="documentTitle" required maxlength="120" /></label>
					<label>归属部门<input v-model="departmentId" required maxlength="64" /></label>
					<label>可见范围
						<select v-model="visibility">
							<option value="company">企业内公开</option>
							<option value="department">仅归属部门</option>
						</select>
					</label>
				</div>

				<label class="file-picker">
					<div><Upload :size="20" /></div>
					<span>{{ selectedFile?.name || '选择 Markdown 文档' }}</span>
					<small>支持 .md，单个文件不超过 2 MB</small>
					<input type="file" accept=".md,text/markdown" required @change="chooseFile" />
				</label>

				<p v-if="saveMessage" class="save-message">{{ saveMessage }}</p>
				<div class="modal-actions">
					<button type="button" class="secondary-button" @click="showDocumentModal = false">取消</button>
					<button class="primary-button" :disabled="savingDocument || !selectedFile">
						<LoaderCircle v-if="savingDocument" :size="17" class="spinning" />
						<Upload v-else :size="17" />保存文档
					</button>
				</div>
			</form>
		</div>
	</div>
</template>

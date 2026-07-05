<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
	BookOpen,
	Building2,
	CheckCircle2,
	ChevronDown,
	CircleAlert,
	Clock3,
	FilePlus2,
	FileText,
	LoaderCircle,
	RefreshCw,
	Search,
	Send,
	ShieldCheck,
	Upload,
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

const users = ref<DemoUser[]>([])
const activeToken = ref('')
const documents = ref<DocumentSummary[]>([])
const serverOnline = ref(false)
const loadingDocuments = ref(false)
const question = ref('3000 元退款需要人工审核吗？')
const asking = ref(false)
const result = ref<QueryResult | null>(null)
const error = ref('')
const showDocumentModal = ref(false)
const savingDocument = ref(false)
const editingDocument = ref<DocumentSummary | null>(null)
const documentTitle = ref('')
const departmentId = ref('customer-service')
const visibility = ref<'company' | 'department'>('company')
const selectedFile = ref<File | null>(null)
const saveMessage = ref('')

const activeUser = computed(() =>
	users.value.find((user) => user.token === activeToken.value)
)
const isAdmin = computed(() => activeUser.value?.role === 'admin')

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

async function ask() {
	if (!question.value.trim() || !activeToken.value) return
	asking.value = true
	error.value = ''
	result.value = null
	try {
		result.value = await queryKnowledge(activeToken.value, question.value.trim())
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
				<div class="brand-mark"><BookOpen :size="20" /></div>
				<div>
					<strong>企业知识库</strong>
					<span>RAG Workspace</span>
				</div>
			</div>

			<div class="topbar-actions">
				<div class="health" :class="{ offline: !serverOnline }">
					<span></span>{{ serverOnline ? '服务正常' : '服务离线' }}
				</div>
				<label class="identity-select">
					<Building2 :size="16" />
					<select v-model="activeToken" @change="changeUser">
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

		<main class="workspace">
			<aside class="documents-panel">
				<div class="panel-heading">
					<div>
						<span class="eyebrow">KNOWLEDGE</span>
						<h2>知识文档</h2>
					</div>
					<div class="heading-actions">
						<button class="icon-button" title="刷新文档" @click="loadDocuments">
							<RefreshCw :size="17" :class="{ spinning: loadingDocuments }" />
						</button>
						<button v-if="isAdmin" class="primary-button compact" @click="openCreate">
							<FilePlus2 :size="16" />上传
						</button>
					</div>
				</div>

				<div class="document-count">
					<ShieldCheck :size="15" />当前身份可访问 {{ documents.length }} 份文档
				</div>

				<div v-if="loadingDocuments" class="panel-loading">
					<LoaderCircle :size="22" class="spinning" />
				</div>
				<div v-else-if="documents.length === 0" class="empty-state small">
					<FileText :size="26" />
					<p>当前身份没有可访问的文档</p>
				</div>
				<div v-else class="document-list">
					<article v-for="document in documents" :key="document.documentId" class="document-row">
						<div class="document-icon"><FileText :size="18" /></div>
						<div class="document-info">
							<h3>{{ document.title }}</h3>
							<div class="document-meta">
								<span>v{{ document.version }}</span>
								<span>{{ document.chunkCount }} Chunks</span>
								<span>{{ document.visibility === 'company' ? '企业公开' : document.departmentId }}</span>
							</div>
							<time><Clock3 :size="13" />{{ formatDate(document.updatedAt) }}</time>
						</div>
						<button
							v-if="isAdmin"
							class="icon-button row-action"
							title="更新文档"
							@click="openUpdate(document)"
						>
							<Upload :size="16" />
						</button>
					</article>
				</div>
			</aside>

			<section class="chat-panel">
				<div class="chat-heading">
					<div>
						<span class="eyebrow">RETRIEVAL</span>
						<h1>知识问答</h1>
					</div>
					<div v-if="activeUser" class="access-badge">
						<ShieldCheck :size="15" />{{ activeUser.role === 'admin' ? '企业管理员' : activeUser.departmentName }}
					</div>
				</div>

				<div class="answer-area">
					<div v-if="asking" class="processing-state">
						<LoaderCircle :size="28" class="spinning" />
						<strong>正在执行混合检索与 Rerank</strong>
					</div>
					<div v-else-if="!result" class="empty-state">
						<Search :size="36" />
						<h2>等待查询</h2>
					</div>
					<template v-else>
						<div class="answer-status" :class="result.status">
							<CheckCircle2 v-if="result.status === 'answered'" :size="18" />
							<CircleAlert v-else :size="18" />
							{{ result.status === 'answered' ? '已有知识库依据' : '知识库依据不足' }}
							<span>{{ result.pipeline.latencyMs }} ms</span>
						</div>
						<div class="answer-copy">{{ result.answer }}</div>

						<section v-if="result.sources.length" class="sources-section">
							<h2>信息来源</h2>
							<article v-for="source in result.sources" :key="source.chunkId" class="source-row">
								<div class="source-title">
									<FileText :size="16" />
									<strong>{{ source.title }}</strong>
									<span>v{{ source.version }} · Chunk {{ source.chunkIndex + 1 }}</span>
								</div>
								<p>{{ source.content }}</p>
								<code>{{ source.chunkId }}</code>
							</article>
						</section>

						<details class="pipeline-details">
							<summary>
								检索链路
								<span>{{ result.pipeline.recalledCount }} 召回 / {{ result.pipeline.rerankedCount }} 精排</span>
							</summary>
							<div class="filter-code">{{ result.pipeline.permissionFilter }}</div>
							<div v-for="candidate in result.pipeline.candidates" :key="candidate.chunkId" class="candidate-row">
								<b>#{{ candidate.rank }} {{ candidate.title }}</b>
								<span>Rerank {{ candidate.rerankScore.toFixed(4) }}</span>
							</div>
						</details>
					</template>
				</div>

				<form class="composer" @submit.prevent="ask">
					<textarea v-model="question" rows="3" maxlength="1000" placeholder="输入需要查询的企业知识问题"></textarea>
					<div class="composer-footer">
						<span>{{ question.length }} / 1000</span>
						<button class="primary-button" :disabled="asking || !question.trim()">
							<Send :size="17" />查询
						</button>
					</div>
				</form>
			</section>
		</main>

		<div v-if="showDocumentModal" class="modal-backdrop" @click.self="showDocumentModal = false">
			<form class="modal" @submit.prevent="submitDocument">
				<div class="modal-heading">
					<div>
						<span class="eyebrow">DOCUMENT</span>
						<h2>{{ editingDocument ? '更新文档版本' : '上传知识文档' }}</h2>
					</div>
					<button type="button" class="icon-button" aria-label="关闭" @click="showDocumentModal = false"><X :size="18" /></button>
				</div>

				<label>文档标题<input v-model="documentTitle" required maxlength="120" /></label>
				<label>归属部门<input v-model="departmentId" required maxlength="64" /></label>
				<label>可见范围
					<select v-model="visibility">
						<option value="company">企业内公开</option>
						<option value="department">仅归属部门</option>
					</select>
				</label>
				<label class="file-picker">
					<Upload :size="19" />
					<span>{{ selectedFile?.name || '选择 Markdown 文档' }}</span>
					<input type="file" accept=".md,text/markdown" required @change="chooseFile" />
				</label>

				<p v-if="saveMessage" class="save-message">{{ saveMessage }}</p>
				<div class="modal-actions">
					<button type="button" class="secondary-button" @click="showDocumentModal = false">取消</button>
					<button class="primary-button" :disabled="savingDocument || !selectedFile">
						<LoaderCircle v-if="savingDocument" :size="17" class="spinning" />
						<Upload v-else :size="17" />保存
					</button>
				</div>
			</form>
		</div>
	</div>
</template>

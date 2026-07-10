const state = {
	users: [],
	activeToken: "",
	documents: [],
};

const userSelect = document.querySelector("#userSelect");
const health = document.querySelector("#health");
const documentsNode = document.querySelector("#documents");
const conversation = document.querySelector("#conversation");
const documentForm = document.querySelector("#documentForm");
const queryForm = document.querySelector("#queryForm");
const saveMessage = document.querySelector("#saveMessage");

function authHeaders() {
	return { Authorization: `Bearer ${state.activeToken}` };
}

async function request(url, options = {}) {
	const response = await fetch(url, options);
	const body = await response.json();
	if (!response.ok) {
		const message = Array.isArray(body.message)
			? body.message.join("；")
			: body.message || `请求失败：${response.status}`;
		throw new Error(message);
	}
	return body;
}

async function loadUsers() {
	state.users = await request("/api/session/users");
	userSelect.innerHTML = state.users
		.map((user) => `<option value="${user.token}">${user.tenantName} · ${user.name} · ${user.departmentName}</option>`)
		.join("");
	state.activeToken = state.users[0]?.token || "";
	userSelect.value = state.activeToken;
}

async function checkHealth() {
	try {
		const result = await request("/api/health");
		health.textContent = result.status === "ok" ? "运行中" : "异常";
		health.classList.remove("offline");
	} catch {
		health.textContent = "服务离线";
		health.classList.add("offline");
	}
}

async function loadDocuments() {
	if (!state.activeToken) return;
	state.documents = await request("/api/documents", {
		headers: authHeaders(),
	});
	renderDocuments();
}

function currentUser() {
	return state.users.find((user) => user.token === state.activeToken);
}

function renderDocuments() {
	const user = currentUser();
	if (state.documents.length === 0) {
		documentsNode.innerHTML = "<div class=\"empty\">当前身份暂无可访问文档</div>";
		return;
	}

	documentsNode.innerHTML = state.documents
		.map((document) => `
			<article class="document-card">
				<h2>${document.title}</h2>
				<div class="meta">v${document.version} · ${document.chunkCount} chunks · ${document.visibility === "company" ? "全员可见" : document.departmentId}</div>
				${user?.role === "admin" ? `
					<div class="actions">
						<button class="secondary" data-update="${document.documentId}">发布新版本</button>
						<button class="danger" data-delete="${document.documentId}">删除</button>
					</div>
				` : ""}
			</article>
		`)
		.join("");
}

function resetDocumentForm() {
	document.querySelector("#editingDocumentId").value = "";
	document.querySelector("#documentTitle").value = "";
	document.querySelector("#departmentId").value = "customer-service";
	document.querySelector("#visibility").value = "company";
	document.querySelector("#documentFile").value = "";
}

documentsNode.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLButtonElement)) return;

	const updateId = target.dataset.update;
	const deleteId = target.dataset.delete;
	if (updateId) {
		const documentItem = state.documents.find((item) => item.documentId === updateId);
		document.querySelector("#editingDocumentId").value = updateId;
		document.querySelector("#documentTitle").value = documentItem.title;
		document.querySelector("#departmentId").value = documentItem.departmentId;
		document.querySelector("#visibility").value = documentItem.visibility;
		saveMessage.textContent = "已进入版本更新模式，请选择新的 Markdown 文件。";
	}
	if (deleteId) {
		await request(`/api/documents/${deleteId}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		await loadDocuments();
	}
});

document.querySelector("#refreshDocuments").addEventListener("click", loadDocuments);

userSelect.addEventListener("change", async () => {
	state.activeToken = userSelect.value;
	resetDocumentForm();
	await loadDocuments();
});

documentForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const file = document.querySelector("#documentFile").files[0];
	if (!file) return;

	const formData = new FormData();
	formData.set("file", file);
	formData.set("title", document.querySelector("#documentTitle").value.trim());
	formData.set("departmentId", document.querySelector("#departmentId").value.trim());
	formData.set("visibility", document.querySelector("#visibility").value);

	const documentId = document.querySelector("#editingDocumentId").value;
	const result = await request(documentId ? `/api/documents/${documentId}` : "/api/documents", {
		method: documentId ? "PUT" : "POST",
		headers: authHeaders(),
		body: formData,
	});
	saveMessage.textContent = result.reason || `文档已保存为 v${result.document.version}`;
	resetDocumentForm();
	await loadDocuments();
});

queryForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const question = document.querySelector("#question").value.trim();
	if (!question) return;

	conversation.querySelector(".empty")?.remove();
	const turn = document.createElement("section");
	turn.className = "turn";
	turn.innerHTML = `<div class="question">${question}</div><div class="answer">正在检索并核对企业知识...</div>`;
	conversation.appendChild(turn);
	conversation.scrollTop = conversation.scrollHeight;

	try {
		const result = await request("/api/knowledge/query", {
			method: "POST",
			headers: {
				...authHeaders(),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ question }),
		});
		turn.innerHTML = renderAnswer(question, result);
	} catch (error) {
		turn.innerHTML = `<div class="question">${question}</div><div class="answer">${error.message}</div>`;
	}
	conversation.scrollTop = conversation.scrollHeight;
});

function renderAnswer(question, result) {
	const sources = result.sources
		.map((source) => `
			<div class="source-card">
				<strong>${source.title}</strong>
				<div class="meta">v${source.version} · Chunk ${source.chunkIndex + 1}</div>
				<p>${source.content}</p>
				<code>${source.chunkId}</code>
			</div>
		`)
		.join("");
	const candidates = result.pipeline.candidates
		.map((item) => `#${item.rank} ${item.title} · ${Number(item.rerankScore ?? 0).toFixed(4)}`)
		.join("<br />");
	return `
		<div class="question">${question}</div>
		<div class="answer">${result.answer}</div>
		<div class="sources"><strong>引用来源：</strong>${sources || "无"}</div>
		<div class="pipeline">
			<strong>检索链路：</strong>${result.pipeline.recalledCount} 召回 · ${result.pipeline.rerankedCount} 精排 · ${result.pipeline.latencyMs} ms
			<code>${result.pipeline.permissionFilter}</code>
			<div>${candidates}</div>
		</div>
	`;
}

async function boot() {
	await Promise.all([loadUsers(), checkHealth()]);
	await loadDocuments();
}

boot().catch((error) => {
	health.textContent = error.message;
	health.classList.add("offline");
});


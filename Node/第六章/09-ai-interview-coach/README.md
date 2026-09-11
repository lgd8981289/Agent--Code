# AI 面试教练 Agent

这是第六章的综合实战项目。项目通过一段完整的面试训练，演示 Thread 级会话恢复、跨 Thread 长期记忆、训练记录更新、记忆管理和 Agentic RAG。

## 本地运行

```bash
docker compose up -d --wait
npm install
npm run setup
npm run dev
```

浏览器打开：`http://localhost:5180`

默认使用 `replay` 模式，不需要模型密钥。它可以稳定复现“回答不完整 → 继续追问 → 保存薄弱点 → 新会话复测”的课程流程。

如需使用真实 DeepSeek，在项目根目录自行创建 `.env`：

```text
MODEL_MODE=ai
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
POSTGRES_URI=postgresql://interview_course:interview_course@localhost:5434/interview_coach
```

## 验证

```bash
npm run doctor
npm run check
npm test
npm run build
```

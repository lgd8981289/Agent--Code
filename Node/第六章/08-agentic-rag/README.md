# 08-Agentic RAG

安装依赖：

```bash
npm install
```

使用 Node.js 20.6+，并在本目录自行准备 `.env`：

```text
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

运行不同场景：

```bash
npm run demo
npm run direct
npm run single
npm run clarify
npm run unknown
```

离线验证：

```bash
npm test
npm run check
```

本案例使用本地 Chunk 模拟第二章已经实现的企业知识检索接口，重点观察检索决策、证据补查、有效性判断和停止条件。真实项目可以将 `knowledge.js` 中的 `searchKnowledge()` 替换成 Milvus 混合检索与 Rerank。

代码不会创建或修改任何环境变量文件。

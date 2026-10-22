import { Pool } from "pg";
import OpenAI from "openai";
import { access } from "node:fs/promises";
import {
  databaseUrl,
  dashscope,
  deepSeekReady,
  inspectConfig,
  modelName,
  multimodalReady,
  root,
  visionModel,
} from "../server/config.js";
import { join } from "node:path";
const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 4000,
});
let failed = false;
const config = inspectConfig();
for (const error of config.errors) {
  failed = true;
  console.error(`✗ 配置：${error}`);
}
for (const warning of config.warnings) console.warn(`⚠ 配置提示：${warning}`);
try {
  await pool.query("SELECT 1");
  console.log("✓ PostgreSQL 连接成功");
} catch (e) {
  failed = true;
  console.error("✗ PostgreSQL：", (e as Error).message, "\n请先执行 npm run db:up");
} finally {
  await pool.end();
}
try {
  await access(join(root, "samples/damaged-coffee-machine.png"));
  console.log("✓ 演示照片已准备");
} catch {
  failed = true;
  console.error("✗ 缺少演示照片");
}
console.log(
  `真实模型：${deepSeekReady() ? "已配置" : "未配置（可使用 Replay）"} · ${modelName}`,
);
console.log(
  `图片与语音：${multimodalReady() ? "已配置" : "未完整配置（照片样本可使用 Replay）"}`,
);
console.log(`视觉模型：${visionModel()}`);
// 显式选择时才联网查询模型目录；普通 doctor 仍只检查本地配置。
if (process.argv.includes("--models")) {
  const { key, baseUrl } = dashscope();
  if (!key) {
    failed = true;
    console.error("✗ 无法检查模型目录：缺少 DASHSCOPE_API_KEY");
  } else {
    try {
      const client = new OpenAI({
        apiKey: key,
        baseURL: baseUrl,
        maxRetries: 0,
        timeout: 15000,
      });
      const models = await client.models.list();
      if (models.data.some((model) => model.id === visionModel()))
        console.log("✓ 配置的视觉模型出现在当前接口目录中；图片识别仍需实际请求验证");
      else {
        failed = true;
        console.error(
          `✗ 当前接口目录未列出 ${visionModel()}，请核对模型名称、地址和权限`,
        );
      }
    } catch {
      failed = true;
      console.error(
        "✗ 无法读取当前接口的模型目录，请检查 Key、地址与网络；尚未验证模型可用性",
      );
    }
  }
}
console.log("密钥不会输出。演示账号用于本地教学，生产系统应接入企业身份服务。");
process.exitCode = failed ? 1 : 0;

import "dotenv/config";
import { resolve } from "node:path";

const defaultDatabaseUrl =
  "postgresql://aftersales_course:aftersales_course@127.0.0.1:5441/aftersales_agent";

// 百炼的图片理解与录音转写走 /compatible-mode/v1 兼容接口，语音合成走
// /api/v1，实时识别走 /api-ws/v1：三者在同一个域名下，只差路径。
// 所以只需要记住一个地址，换地域或换业务空间时也只改一处。
const defaultDashscopeBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const value = (name: string) => process.env[name]?.trim() || "";

export type ConfigReport = {
  errors: string[];
  warnings: string[];
};

export const root = resolve(value("PROJECT_ROOT") || process.cwd());
export const databaseUrl = value("POSTGRES_URI") || defaultDatabaseUrl;

function configuredPort(name: string, fallback: number) {
  const raw = value(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

export const port = configuredPort("PORT", 4320);
export const webPort = configuredPort("WEB_PORT", 5190);

// DeepSeek 在 2026 年将 V4.1 Flash 的 API 名称统一为 deepseek-flash。
// 保留环境变量覆盖，方便课程演示固定到其他兼容模型。
export const modelName = value("DEEPSEEK_MODEL") || "deepseek-flash";

// 默认值是本项目验证过的选择；实际可用性取决于账号、地域与接口。
// 显式配置始终优先，不把某次 404 当作所有账号都应切换模型的依据。
export function visionModel(env: NodeJS.ProcessEnv = process.env) {
  return env.VISION_MODEL?.trim() || "qwen3-vl-plus";
}
// 语音的模型名直接写在调用处（server/voice/asr.ts 与 materials.service.ts），
// 和第九章语音小节保持一致：这两个模型没有可换的必要，多一个环境变量只是噪音。

function parseHttpUrl(raw: string, label: string) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("协议必须是 http 或 https");
    return url;
  } catch (error) {
    return { error: `${label} 不是有效的 HTTP(S) 地址：${(error as Error).message}` };
  }
}

// 调用时读取，而不是在模块加载时固化成常量：测试与脚本会在运行中改环境变量。
export function dashscope(env: NodeJS.ProcessEnv = process.env) {
  return {
    key: env.DASHSCOPE_API_KEY?.trim() || "",
    baseUrl: env.DASHSCOPE_BASE_URL?.trim() || defaultDashscopeBaseUrl,
  };
}

export function inspectConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const envValue = (name: string) => env[name]?.trim() || "";

  for (const [name, fallback] of [
    ["PORT", 4320],
    ["WEB_PORT", 5190],
  ] as const) {
    const raw = envValue(name);
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
      errors.push(
        `${name} 必须是 1 到 65535 之间的整数（当前值无效，默认值为 ${fallback}）`,
      );
  }

  try {
    const url = new URL(envValue("POSTGRES_URI") || defaultDatabaseUrl);
    if (!/^postgres(?:ql)?:$/.test(url.protocol))
      errors.push("POSTGRES_URI 必须使用 postgresql:// 连接字符串");
  } catch {
    errors.push("POSTGRES_URI 不是有效的 PostgreSQL 连接字符串");
  }

  const deepSeekModel = envValue("DEEPSEEK_MODEL");
  // 未填写 DEEPSEEK_MODEL 属于正常情况：默认值已经写在 config 里，不必提醒。
  if (
    deepSeekModel &&
    !["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"].includes(deepSeekModel)
  )
    warnings.push(
      `DEEPSEEK_MODEL=${deepSeekModel} 不在课程验证过的模型名称中，请确认供应商仍支持它`,
    );
  const deepSeekBase = parseHttpUrl(envValue("DEEPSEEK_BASE_URL"), "DEEPSEEK_BASE_URL");
  if (deepSeekBase && "error" in deepSeekBase) warnings.push(deepSeekBase.error);

  const dashKey = envValue("DASHSCOPE_API_KEY");
  const dashBase = parseHttpUrl(
    envValue("DASHSCOPE_BASE_URL") || defaultDashscopeBaseUrl,
    "DASHSCOPE_BASE_URL",
  );
  if (dashBase && "error" in dashBase) warnings.push(dashBase.error);
  else if (dashBase) {
    if (!/\/compatible-mode\/v1\/?$/.test(dashBase.pathname))
      warnings.push("DASHSCOPE_BASE_URL 应指向兼容接口的 /compatible-mode/v1 路径");
    // 控制台页面、OpenAPI 域名都长得像，但只有下面这些能同时提供图片、ASR 与 TTS。
    if (
      !/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[\w-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)$/.test(
        dashBase.hostname,
      )
    )
      warnings.push(
        "DASHSCOPE_BASE_URL 不是百炼的兼容接口域名，请从控制台复制完整地址",
      );
  }
  if (!dashKey && envValue("DASHSCOPE_BASE_URL"))
    warnings.push(
      "已配置 DASHSCOPE_BASE_URL，但缺少 DASHSCOPE_API_KEY，多模态入口不可用",
    );

  return { errors, warnings };
}

export function deepSeekReady(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.DEEPSEEK_API_KEY?.trim());
}

export function multimodalReady(env: NodeJS.ProcessEnv = process.env) {
  if (!dashscope(env).key) return false;
  const base = parseHttpUrl(dashscope(env).baseUrl, "DASHSCOPE_BASE_URL");
  return (
    !!base && !("error" in base) && /\/compatible-mode\/v1\/?$/.test(base.pathname)
  );
}

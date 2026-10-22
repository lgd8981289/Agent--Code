import "reflect-metadata";
import { Storage } from "./storage.js";
import { AppModule } from "./modules.js";
import { Catch, ArgumentsHost, ExceptionFilter, HttpException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";
import { ZodError } from "zod";
import { json, static as serveStatic } from "express";
import type { Request, Response, NextFunction } from "express";
import { join } from "node:path";
import { inspectConfig, port, root, webPort } from "./config.js";

const config = inspectConfig();
if (config.warnings.length)
  for (const warning of config.warnings) console.warn(`配置提示：${warning}`);
if (config.errors.length) {
  console.error("启动失败：配置存在错误：");
  for (const error of config.errors) console.error(`- ${error}`);
  process.exit(1);
}

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      error instanceof ZodError
        ? 400
        : error instanceof HttpException
          ? error.getStatus()
          : 500;
    const message =
      error instanceof ZodError
        ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；")
        : (error as Error).message || "请求失败";
    response.status(status).json({ message });
  }
}
// HTTP 与 WebSocket 使用同一份来源白名单：实时识别通道会产生真实模型费用，不能放开给任意页面。
const origins = new Set(
  [
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    process.env.PUBLIC_ORIGIN,
  ].filter((value): value is string => !!value),
);

const app = await NestFactory.create(AppModule, { bodyParser: false });
app.use(json({ limit: "100kb" }));
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.headers.origin && !origins.has(req.headers.origin)) {
    res.status(403).json({ message: "不允许的请求来源" });
    return;
  }
  next();
});
// 语音识别走 WebSocket：升级请求在 listen 之前就要挂好适配器。
const ws = new WsAdapter(app);
const create = ws.create.bind(ws);
ws.create = (value: number, options: Record<string, unknown> = {}) =>
  create(value, {
    ...options,
    maxPayload: 256 * 1024,
    verifyClient: (info: { origin?: string }) => origins.has(info.origin || ""),
  });
app.useWebSocketAdapter(ws);
app.useGlobalFilters(new Errors());
app.enableShutdownHooks();
try {
  await app.get(Storage).setup();
  if (process.env.NODE_ENV === "production")
    app.use(serveStatic(join(root, "web/dist")));
  await app.listen(port, "127.0.0.1");
  console.log(`售后 Agent API：http://127.0.0.1:${port}`);
} catch (e) {
  console.error(
    "启动失败：",
    (e as Error).message,
    "\n请先运行 npm run db:up，再运行 npm run setup。",
  );
  await app.close();
  process.exitCode = 1;
}

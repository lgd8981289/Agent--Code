import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Auth } from "./auth.js";
import { ApplicationService } from "./app.service.js";
import { Materials } from "./materials.service.js";
import { Memories } from "./memory.service.js";
import { deepSeekReady, multimodalReady, root } from "./config.js";
import { accounts } from "./fixtures.js";
import { Evaluations } from "./evaluation.service.js";
import { assertCustomer, assertReviewer, caseStatuses } from "./domain.js";
import type { ConsultationEvent } from "../shared/types.js";
const id = z.string().uuid();
const mode = z.enum(["replay", "ai"]);
function disconnectSignal(res: Response) {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
const mutation = z.object({
  version: z.number().int().positive(),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1500),
});

@Controller("api")
export class AppController {
  constructor(
    @Inject(Auth) readonly auth: Auth,
    @Inject(ApplicationService) readonly app: ApplicationService,
    @Inject(Materials) readonly materials: Materials,
    @Inject(Memories) readonly memory: Memories,
    @Inject(Evaluations) readonly evaluations: Evaluations,
  ) {}
  @Get("health") health() {
    return { ok: true, service: "aftersales-agent" };
  }
  @Get("meta") meta() {
    return {
      accounts,
      aiReady: deepSeekReady(),
      multimodalReady: multimodalReady(),
    };
  }
  @Post("login") async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.auth.login(
      z.object({ accountId: z.string() }).parse(body).accountId,
      response,
    );
  }
  @Get("bootstrap") async bootstrap(@Req() req: Request) {
    return this.app.bootstrap(await this.auth.actor(req));
  }
  @Get("conversations") async conversations(@Req() req: Request) {
    return this.app.conversationSummaries(await this.auth.actor(req));
  }
  @Get("evaluations") async evaluationReports(@Req() req: Request) {
    const actor = await this.auth.actor(req);
    assertReviewer(actor);
    return this.evaluations.list(actor);
  }
  @Get("cases") async listCases(@Req() req: Request, @Query() query: unknown) {
    const input = z
      .object({
        query: z.string().trim().max(100).default(""),
        status: z.enum(caseStatuses).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
        sort: z.enum(["updated", "oldest"]).default("updated"),
      })
      .parse(query);
    return this.app.casePage(await this.auth.actor(req), input);
  }
  @Post("conversations/:id/rename") async rename(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.app.renameConversation(
      await this.auth.actor(req),
      id.parse(value),
      z.object({ title: z.string().trim().min(1).max(50) }).parse(body).title,
    );
  }
  @Post("conversations") async create(@Req() req: Request, @Body() body: unknown) {
    return this.app.createConversation(
      await this.auth.actor(req),
      z.object({ mode }).parse(body).mode,
    );
  }
  @Post("conversations/:id/delete") async deleteConversation(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.setConversationDeleted(
      await this.auth.actor(req),
      id.parse(value),
      true,
    );
  }
  @Post("conversations/:id/restore") async restoreConversation(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.setConversationDeleted(
      await this.auth.actor(req),
      id.parse(value),
      false,
    );
  }
  @Get("conversations/:id") async conversation(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.conversation(await this.auth.actor(req), id.parse(value));
  }
  @Post("conversations/:id/messages") async send(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.app.send(
      await this.auth.actor(req),
      id.parse(value),
      z.object({ message: z.string().trim().min(1).max(2000) }).parse(body).message,
    );
  }

  /** 通过 SSE 流式发送咨询消息，实时返回处理进度、执行结果或错误信息。 */
  @Post("conversations/:id/messages/stream")
  async streamMessages(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    // 获取当前请求的用户身份，并确认其具有客户权限。
    const actor = await this.auth.actor(req);
    assertCustomer(actor);

    // 校验会话 ID 和消息内容，消息不能为空且最多包含 2000 个字符。
    const conversationId = id.parse(value);
    const { message } = z
      .object({ message: z.string().trim().min(1).max(2000) })
      .parse(body);

    // 检查当前用户是否有权访问指定会话。
    await this.app.conversation(actor, conversationId);

    // 获取连接中断信号，用于在客户端断开连接时取消后续处理。
    const signal = disconnectSignal(res);

    // 设置 SSE 响应头，声明事件流格式并禁用缓存和代理缓冲。
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });

    // 立即发送响应头，建立 SSE 流式连接。
    res.flushHeaders();

    // 向客户端推送 SSE 事件；连接中断或响应结束后不再发送。
    const emit = (event: ConsultationEvent) => {
      if (!signal.aborted && !res.writableEnded)
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // 每 15 秒发送一次 SSE 注释作为心跳，避免空闲连接被中间层关闭。
    const heartbeat = setInterval(() => {
      if (!signal.aborted && !res.writableEnded) res.write(": heartbeat\n\n");
    }, 15000);

    try {
      // 先通知客户端当前处理状态。
      emit({ type: "status", message: "正在核对订单与资料…" });

      // 执行消息处理，将取消信号和事件推送函数传入业务层。
      // 业务执行期间可以通过 emit 持续向客户端返回进度。
      const conversation = await this.app.send(actor, conversationId, message, {
        signal,
        emit,
      });

      // 处理完成后，发送包含最新会话数据的结束事件。
      emit({ type: "done", conversation });
    } catch (error) {
      // 处理失败时，通过 SSE 向客户端推送错误信息。
      emit({ type: "error", message: (error as Error).message });
    } finally {
      // 无论执行成功或失败，都清除心跳定时器并结束响应。
      clearInterval(heartbeat);
      res.end();
    }
  }

  @Get("conversations/:id/materials") async listMaterials(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.materialList(await this.auth.actor(req), id.parse(value));
  }
  @Post("conversations/:id/materials")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  /** 接收用户上传的材料文件，校验会话 ID 后交由业务层保存。 */
  async upload(
    @Req() req: Request,
    @Param("id") value: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // 检查是否上传了文件，未提供文件时直接抛出异常。
    if (!file) throw new Error("请选择材料文件");

    // 获取当前用户身份，并校验 URL 中的会话 ID。
    // 将文件内容、原始文件名和 MIME 类型交给业务层处理。
    return this.app.addMaterial(
      await this.auth.actor(req),
      id.parse(value),
      file.buffer, // 文件的二进制内容。
      file.originalname, // 用户上传时的原始文件名。
      file.mimetype, // 文件的 MIME 类型，例如 image/png。
    );
  }
  @Post("conversations/:id/sample") async sample(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.addMaterial(
      await this.auth.actor(req),
      id.parse(value),
      await readFile(join(root, "samples/damaged-coffee-machine.png")),
      "演示样本-咖啡机损坏.png",
      "image/png",
    );
  }
  @Post("materials/:id/confirm") async confirm(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        observation: z.string().trim().min(1).max(2000),
        version: z.number().int().positive().optional(),
      })
      .parse(body);
    return this.app.confirmMaterial(
      await this.auth.actor(req),
      id.parse(value),
      input.observation,
      input.version,
    );
  }
  @Post("materials/:id/remove") async remove(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.app.removeMaterial(
      await this.auth.actor(req),
      id.parse(value),
      z.object({ version: z.number().int().positive().optional() }).parse(body).version,
    );
  }
  @Get("materials/:id/content") async image(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") value: string,
  ) {
    const actor = await this.auth.actor(req),
      item = await this.materials.get(actor, id.parse(value), true);
    res
      .type(item.mime)
      .set("Cache-Control", "private, no-store")
      .send(await readFile(join(root, "data/materials", item.id)));
  }
  @Post("conversations/:id/submit") async submit(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const input = mutation
      .omit({ version: true })
      .extend({
        orderId: z.string().min(1).max(30),
        draftVersion: z.number().int().nonnegative(),
        fault: z
          .enum(["none", "timeout_after_commit", "before_submit"])
          .default("none"),
      })
      .parse(body);
    return this.app.submit(await this.auth.actor(req), id.parse(value), input);
  }
  @Get("cases/:id") async getCase(@Req() req: Request, @Param("id") value: string) {
    return this.app.getCase(await this.auth.actor(req), id.parse(value));
  }
  @Get("cases/:id/materials") async caseMaterials(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    const actor = await this.auth.actor(req),
      item = await this.app.getCase(actor, id.parse(value));
    const snapshots = item.history?.at(-1)?.materials;
    return Promise.all(
      item.materialIds.map((materialId) =>
        this.materials.get(actor, materialId, true).then((material) => {
          const snapshot = snapshots?.find((m) => m.id === materialId);
          return snapshot
            ? { ...material, observation: snapshot.observation }
            : material;
        }),
      ),
    );
  }
  @Post("cases/:id/revise") async revise(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.app.revise(
      await this.auth.actor(req),
      id.parse(value),
      mutation.parse(body),
    );
  }
  @Post("cases/:id/review") async review(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.app.review(
      await this.auth.actor(req),
      id.parse(value),
      z
        .object({
          version: z.number().int().positive(),
          decision: z.enum(["approve", "revise", "reject"]),
          note: z.string().trim().max(1000).default(""),
        })
        .parse(body),
    );
  }
  @Post("cases/:id/retry") async retry(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.retry(await this.auth.actor(req), id.parse(value));
  }
  @Post("cases/:id/cancel") async cancel(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        version: z.number().int().positive(),
        reason: z.string().trim().min(3).max(500),
      })
      .parse(body);
    return this.app.cancel(
      await this.auth.actor(req),
      id.parse(value),
      input.version,
      input.reason,
    );
  }
  @Post("cases/:id/investigate") async investigate(
    @Req() req: Request,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.app.investigate(
      await this.auth.actor(req),
      id.parse(value),
      z.object({ mode }).parse(body).mode,
    );
  }
  @Get("cases/:id/report") async report(
    @Req() req: Request,
    @Param("id") value: string,
    @Res() res: Response,
  ) {
    const item = await this.app.getCase(await this.auth.actor(req), id.parse(value));
    res.attachment(`${item.number}-report.json`).json({
      application: item,
      traces: await this.app.traces(await this.auth.actor(req), item.id, "case"),
    });
  }
  @Get("conversations/:id/traces") async chatTraces(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.traces(await this.auth.actor(req), id.parse(value), "conversation");
  }
  @Get("cases/:id/traces") async caseTraces(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    return this.app.traces(await this.auth.actor(req), id.parse(value), "case");
  }
  @Post("preferences") async preference(@Req() req: Request, @Body() body: unknown) {
    const actor = await this.auth.actor(req);
    assertCustomer(actor);
    return this.memory.save(
      actor,
      z.object({ value: z.string().min(1).max(100) }).parse(body).value,
    );
  }
  @Post("preferences/forget") async forget(@Req() req: Request) {
    const actor = await this.auth.actor(req);
    assertCustomer(actor);
    return this.memory.forget(actor);
  }
  @Post("voice/transcribe")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    }),
  )
  async transcribe(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.actor(req);
    if (!file) throw new Error("录音不能为空");
    return this.materials.transcribe(file.buffer, file.mimetype, disconnectSignal(res));
  }
  @Post("voice/speak") async speak(
    @Req() req: Request,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    await this.auth.actor(req);
    const audio = await this.materials.speakAudio(
      z.object({ text: z.string().min(1).max(1500) }).parse(body).text,
      disconnectSignal(res),
    );
    res.set("Cache-Control", "private, no-store").type("audio/wav").send(audio);
  }
  @Post("evaluations") async evaluate(@Req() req: Request, @Body() body: unknown) {
    const actor = await this.auth.actor(req);
    assertReviewer(actor);
    const input = z
      .object({
        version: z.enum(["baseline", "current"]).default("current"),
        mode: z.enum(["replay", "ai"]).default("replay"),
        model: z.string().trim().min(1).max(100).optional(),
        prompt: z.string().trim().min(1).max(6000).optional(),
      })
      .parse(body);
    return this.evaluations.run(actor, input.version, input);
  }
  @Post("conversations/:id/judge") async judge(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    const actor = await this.auth.actor(req),
      c = await this.app.conversation(actor, id.parse(value));
    return this.evaluations.judge(
      c,
      await this.app.traces(actor, c.id, "conversation"),
    );
  }
}

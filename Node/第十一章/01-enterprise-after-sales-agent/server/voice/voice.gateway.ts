import { Inject, Injectable } from "@nestjs/common";
import {
  WebSocketGateway,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { Request } from "express";
import WebSocket from "ws";
import { Auth } from "../auth.js";
import { openRecognition, type Recognition } from "./asr.js";
import { normalizeOrderIds } from "./normalize.js";

type Session = {
  turnId: string;
  controller: AbortController;
  recognition: Recognition;
  actorId: string;
};

/**
 * 实时识别通道。
 *
 * 只负责把音频转成文本，不做业务判断：最终文本进入输入框，由用户核对后再发送，
 * 仍然走 `ApplicationService.send()` 那套权限、金额和审批规则。
 *
 * 路径必须在 `/api` 下：登录 Cookie 的作用域是 `path=/api`，挂在别处浏览器不会带，
 * 而这条通道会消耗真实模型额度，不能开成匿名接口。
 */
@Injectable()
@WebSocketGateway({ path: "/api/voice" })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private active = new Map<WebSocket, Session>();
  private actors = new Map<WebSocket, string>();
  // 鉴权要查数据库，而客户端可能在连接建立后立刻发送 listen。
  // 用同一个 Promise 串起来，避免“消息比身份先到”的竞态。
  private pending = new WeakMap<WebSocket, Promise<string | null>>();

  // tsx 用 esbuild 编译，不会生成 design:paramtypes，所以这里必须显式写 @Inject，
  // 否则 auth 注入进来是 undefined，握手时一访问就抛 Internal server error。
  constructor(@Inject(Auth) readonly auth: Auth) {}

  handleConnection(socket: WebSocket, request: IncomingMessage) {
    const identity = this.auth
      .actor(request as unknown as Request)
      .then((actor) => {
        this.actors.set(socket, actor.id);
        return actor.id;
      })
      .catch(() => {
        socket.close(4001, "请先选择演示账号");
        return null;
      });
    this.pending.set(socket, identity);
  }

  @SubscribeMessage("listen")
  async listen(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() data: { turnId: string },
  ) {
    const actorId = this.actors.get(socket) ?? (await this.pending.get(socket)) ?? null;
    if (!actorId) {
      socket.close(4001, "请先选择演示账号");
      return;
    }
    this.reset(socket);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(data?.turnId || "")) return;
    const controller = new AbortController();
    const emit = (event: string, details: Record<string, unknown> = {}) => {
      if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            event,
            data: {
              ...details,
              // 收尾时把「A 一 零 二 四」还原成 A1024，订单号才能被后面识别到。
              ...(event === "asr.final"
                ? { text: normalizeOrderIds(String(details.text || "")) }
                : {}),
              turnId: data.turnId,
            },
          }),
        );
    };
    try {
      const recognition = openRecognition(controller.signal, emit);
      this.active.set(socket, {
        turnId: data.turnId,
        controller,
        recognition,
        actorId,
      });
      await recognition.done;
    } catch (error) {
      emit("error", { message: (error as Error).message });
    } finally {
      if (this.active.get(socket)?.controller === controller)
        this.active.delete(socket);
    }
  }

  @SubscribeMessage("audio")
  audio(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() data: { turnId: string; audio: string },
  ) {
    this.use(socket, data.turnId, (recognition) => recognition.append(data.audio));
  }

  @SubscribeMessage("finish")
  finish(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() data: { turnId: string },
  ) {
    this.use(socket, data.turnId, (recognition) => recognition.finish());
  }

  @SubscribeMessage("cancel")
  cancel(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() data: { turnId: string },
  ) {
    // 只取消本轮的识别连接，Socket 本身留给下一次录音复用。
    const session = this.active.get(socket);
    if (session?.turnId === data.turnId) this.reset(socket);
  }

  private use(
    socket: WebSocket,
    turnId: string,
    action: (recognition: Recognition) => void,
  ) {
    const session = this.active.get(socket);
    if (!session || session.turnId !== turnId) return;
    try {
      action(session.recognition);
    } catch (error) {
      socket.send(
        JSON.stringify({
          event: "error",
          data: { turnId, message: (error as Error).message },
        }),
      );
      this.reset(socket);
    }
  }

  /** 结束当前轮次的识别，保留这条连接的身份。 */
  private reset(socket: WebSocket) {
    this.active
      .get(socket)
      ?.controller.abort(new DOMException("录音已停止", "AbortError"));
    this.active.delete(socket);
  }

  handleDisconnect(socket: WebSocket) {
    this.reset(socket);
    this.actors.delete(socket);
  }
}

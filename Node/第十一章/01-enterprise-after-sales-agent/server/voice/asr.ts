import WebSocket from "ws";
import { randomUUID } from "node:crypto";

/**
 * 实时识别地址由同一地域的兼容接口域名推导，协议固定为 /api-ws/v1/realtime。
 * 密钥只在服务端出现，浏览器拿到的是一个已经鉴权的 WebSocket，不接触 Key。
 */
export function asrConfig(env: NodeJS.ProcessEnv = process.env) {
  const key = env.DASHSCOPE_API_KEY?.trim() || "";
  const raw = env.DASHSCOPE_BASE_URL?.trim() || "";
  if (!key || !raw)
    throw new Error("实时语音识别需要配置 DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL");
  const base = new URL(raw);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.port ||
    base.pathname.replace(/\/$/, "") !== "/compatible-mode/v1"
  )
    throw new Error(
      "DASHSCOPE_BASE_URL 必须是 https 的 /compatible-mode/v1 兼容接口地址",
    );
  return {
    key,
    url: `wss://${base.host}/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`,
  };
}

export type Recognition = {
  append(audio: string): void;
  finish(): void;
  done: Promise<void>;
};

/**
 * 把浏览器采集的 PCM 音频块转发给实时识别，并分别回传预览文本和最终文本。
 * 预览只用于显示，最终文本仍会进入输入框由用户确认，不直接提交。
 */
export function openRecognition(
  signal: AbortSignal,
  emit: (event: string, data?: Record<string, unknown>) => void,
  config = asrConfig(),
): Recognition {
  signal.throwIfAborted();
  const socket = new WebSocket(config.url, {
    headers: {
      Authorization: `Bearer ${config.key}`,
      "OpenAI-Beta": "realtime=v1",
    },
    handshakeTimeout: 10000,
    maxPayload: 256 * 1024,
  });

  let ready = false;
  let ending = false;
  let settled = false;
  let bytes = 0;
  // 按句子保存识别文本：预览用临时文本，收尾用最终文本。
  const items = new Map<string, { text: string; final: boolean }>();
  const preview = () => [...items.values()].map((item) => item.text).join("");
  // 空文本不回传：否则浏览器会把用户刚才看到的预览文字清空。
  const emitPartial = () => {
    const text = preview();
    if (text) emit("asr.partial", { text });
  };

  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  const send = (type: string, body: object = {}) =>
    socket.send(JSON.stringify({ event_id: randomUUID(), type, ...body }));

  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close();
    if (error) reject(error);
    else resolve();
  };
  const abort = () => settle(signal.reason);
  // 与批量接口保持同一上限：单轮最多 45 秒，避免异常连接一直挂着。
  const timer = setTimeout(() => settle(new Error("识别超时，请重新录音")), 45000);
  signal.addEventListener("abort", abort, { once: true });

  socket.on("open", () =>
    send("session.update", {
      session: {
        input_audio_format: "pcm",
        sample_rate: 16000,
        input_audio_transcription: { language: "zh" },
        // 静音 600ms 由服务端判断一句结束，用户不必逐句停顿。
        turn_detection: {
          type: "server_vad",
          threshold: 0,
          silence_duration_ms: 600,
        },
      },
    }),
  );

  socket.on("message", (raw) => {
    if (settled) return;
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === "session.updated" && !ready) {
        ready = true;
        emit("asr.ready");
      }
      if (event.type === "conversation.item.created" && event.item?.id)
        if (!items.has(event.item.id))
          items.set(event.item.id, { text: "", final: false });
      if (event.type === "conversation.item.input_audio_transcription.text") {
        if (!event.item_id) throw new Error("识别结果缺少句子编号");
        if (!items.get(event.item_id)?.final) {
          items.set(event.item_id, {
            text: (event.text || "") + (event.stash || ""),
            final: false,
          });
          emitPartial();
        }
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        if (!event.item_id) throw new Error("识别结果缺少句子编号");
        items.set(event.item_id, {
          text: String(event.transcript || "").trim(),
          final: true,
        });
        emitPartial();
      }
      if (
        event.type === "conversation.item.input_audio_transcription.failed" ||
        event.type === "error"
      )
        throw new Error(event.error?.message || "ASR 服务返回错误");
      if (items.size > 100 || preview().length > 2000)
        throw new Error("识别内容过长，请缩短问题");
      if (event.type === "session.finished") {
        const text = preview().trim();
        if (!text || [...items.values()].some((item) => item.text && !item.final))
          // 静音或噪声也会走到这里，提示要说人话，而不是报一个看不懂的错误。
          throw new Error("没有识别到内容，请靠近麦克风再说一次");
        emit("asr.final", { text });
        settle();
      }
    } catch (error) {
      settle(error as Error);
    }
  });

  socket.on("error", (error) => settle(error));
  socket.on("close", () => {
    if (!settled) settle(new Error("识别连接提前关闭，请重新录音"));
  });

  return {
    done,
    append(audio) {
      if (!ready || ending || settled) throw new Error("当前识别会话不能接收音频");
      if (
        typeof audio !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) ||
        audio.length > 24000
      )
        throw new Error("音频块格式错误");
      const chunk = Buffer.from(audio, "base64");
      bytes += chunk.length;
      // 16 位 PCM 每采样 2 字节；单轮上限 30 秒。
      if (chunk.length % 2 || bytes > 16000 * 2 * 31)
        throw new Error("录音格式错误或超过 30 秒");
      if (socket.bufferedAmount > 128000) throw new Error("网络发送过慢，请重新录音");
      send("input_audio_buffer.append", { audio });
    },
    finish() {
      if (ending || settled) return;
      if (!ready || bytes < 3200) throw new Error("录音过短，请至少说一句完整的问题");
      ending = true;
      send("session.finish");
    },
  };
}

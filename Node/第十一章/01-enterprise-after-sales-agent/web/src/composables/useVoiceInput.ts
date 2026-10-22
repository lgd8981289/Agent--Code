import { computed, onScopeDispose, ref, type Ref } from "vue";
import { api } from "../api";
import { Microphone, UploadRecording } from "../recorder";

type Options = {
  message: Ref<string>;
  enabled: () => boolean;
  beforeStart: () => void;
  onError: (error: unknown) => void;
  onSuccess: (message: string) => void;
};
/** 实时与整段上传共用一轮识别身份；取消后，迟到结果不能写回草稿。 */
export function useVoiceInput(options: Options) {
  const phase = ref<"idle" | "preparing" | "recording" | "transcribing">("idle");
  const recording = computed(() => phase.value === "recording");
  const voiceBusy = computed(() => ["preparing", "transcribing"].includes(phase.value));
  let turnId = "",
    draft = "";
  let microphone: Microphone | undefined, upload: UploadRecording | undefined;
  let socket: WebSocket | undefined, abort: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  function stopVoice() {
    const previous = turnId;
    turnId = "";
    clearTimer();
    abort?.abort();
    abort = undefined;
    void microphone?.stop(true).catch(() => {});
    microphone = undefined;
    upload?.cancel();
    upload = undefined;
    if (socket?.readyState === WebSocket.OPEN && previous)
      socket.send(JSON.stringify({ event: "cancel", data: { turnId: previous } }));
    socket?.close();
    socket = undefined;
    phase.value = "idle";
  }
  function fail(id: string, error: unknown) {
    if (turnId !== id) return;
    stopVoice();
    options.onError(error);
  }
  function complete(id: string, text: string) {
    if (turnId !== id) return;
    if (text.trim())
      options.message.value = [draft, text.trim()].filter(Boolean).join(" ");
    stopVoice();
    options.onSuccess(
      text.trim() ? "语音已转成文字，请核对后再发送" : "未识别到文字，请重新录音",
    );
  }
  async function finishVoice() {
    if (!recording.value) return;
    const id = turnId;
    phase.value = "transcribing";
    clearTimer();
    if (upload) {
      upload.finish();
      return;
    }
    try {
      await microphone?.stop();
      microphone = undefined;
      if (turnId === id && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ event: "finish", data: { turnId: id } }));
    } catch (error) {
      fail(id, error);
    }
  }
  async function recordByUpload(id: string) {
    const current = new UploadRecording();
    upload = current;
    await current.prepare();
    if (turnId !== id) {
      current.cancel();
      return;
    }
    current.start(
      (audio) => {
        if (turnId !== id) return;
        phase.value = "transcribing";
        clearTimer();
        const controller = new AbortController();
        abort = controller;
        const body = new FormData();
        body.append(
          "file",
          audio,
          audio.type.includes("webm") ? "question.webm" : "question.mp4",
        );
        void api<{ text: string }>("/voice/transcribe", body, controller.signal)
          .then((result) => complete(id, result.text))
          .catch((error) => fail(id, error));
      },
      (error) => fail(id, error),
    );
    phase.value = "recording";
    timer = setTimeout(() => void finishVoice(), 30000);
  }

  /** 切换语音录制状态：启动录音、结束录音，并处理实时语音识别及降级上传。 */
  async function toggleRecording() {
    // 正在录音时，再次点击则结束录音并处理识别结果。
    if (recording.value) {
      await finishVoice();
      return;
    }

    // 语音功能正在处理中时，允许用户主动停止当前任务。
    if (voiceBusy.value) {
      stopVoice();
      return;
    }

    // 检查当前是否允许使用语音功能，并执行录音前的准备操作。
    if (!options.enabled()) return;
    options.beforeStart();
    stopVoice();

    // 为本轮语音交互生成唯一 ID，并保留输入框中已有的文本。
    const id = crypto.randomUUID();
    turnId = id;
    draft = options.message.value.trim();
    phase.value = "preparing";

    // 创建麦克风实例，将采集到的音频通过 WebSocket 实时发送给服务端。
    // 只有当前轮次匹配且连接处于 OPEN 状态时才发送。
    const current = new Microphone((audio) => {
      if (turnId === id && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ event: "audio", data: { turnId: id, audio } }));
    });
    microphone = current;

    try {
      // 准备麦克风，申请录音权限并初始化音频采集资源。
      await current.prepare();
    } catch (error) {
      // 麦克风准备失败时，先释放已创建的音频资源。
      await current.stop(true).catch(() => {});

      // 如果当前语音轮次已经发生变化，则忽略本次过期结果。
      if (turnId !== id) return;
      microphone = undefined;

      // 用户拒绝授权或设备不存在时，直接返回错误，不进行降级录音。
      if (["NotAllowedError", "NotFoundError"].includes((error as Error).name)) {
        fail(id, error);
        return;
      }

      // 其他麦克风初始化异常，尝试降级为录音文件上传识别。
      try {
        await recordByUpload(id);
      } catch (fallbackError) {
        fail(id, fallbackError);
      }
      return;
    }

    // 麦克风准备完成后，再次确认本轮任务仍然有效。
    if (turnId !== id) return;

    // 建立语音识别 WebSocket 连接，根据页面协议自动选择 ws 或 wss。
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice`,
    );
    socket = ws;

    // 限制语音连接准备时间，15 秒内未完成则报告超时。
    timer = setTimeout(() => fail(id, new Error("语音连接超时，请重新录音")), 15000);

    // WebSocket 连接成功后，发送 listen 事件，请求服务端启动语音识别。
    ws.onopen = () => {
      if (turnId === id)
        ws.send(JSON.stringify({ event: "listen", data: { turnId: id } }));
    };

    // 接收服务端推送的语音识别事件。
    ws.onmessage = ({ data }) => {
      // 忽略不属于当前语音轮次的消息。
      if (turnId !== id) return;

      try {
        const packet = JSON.parse(String(data));
        if (packet.data?.turnId !== id) return;

        // 服务端识别服务就绪后，启动麦克风采集并进入录音状态。
        // 同时设置 30 秒录音时限，到期后自动结束。
        if (packet.event === "asr.ready") {
          clearTimer();
          current.start();
          phase.value = "recording";
          timer = setTimeout(() => void finishVoice(), 30000);
        }

        // 收到中间识别结果时，将原有输入与实时识别文本合并展示。
        if (packet.event === "asr.partial" && packet.data.text)
          options.message.value = [draft, String(packet.data.text).trim()]
            .filter(Boolean)
            .join(" ");

        // 收到最终识别结果时，完成本轮语音处理。
        if (packet.event === "asr.final") complete(id, String(packet.data.text || ""));

        // 服务端主动返回错误时，进入统一失败处理。
        if (packet.event === "error") fail(id, new Error(packet.data.message));
      } catch (error) {
        // 消息解析或事件处理出现异常时，统一处理错误。
        fail(id, error);
      }
    };

    // WebSocket 发生连接错误或意外关闭时，进入失败处理。
    ws.onerror = () => fail(id, new Error("语音连接失败，请确认服务端已启动"));
    ws.onclose = () => fail(id, new Error("识别连接已断开，请重新录音"));
  }

  onScopeDispose(stopVoice);
  return { recording, voiceBusy, toggleRecording, stopVoice };
}

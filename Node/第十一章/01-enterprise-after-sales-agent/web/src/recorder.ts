/**
 * 采集 16kHz 单声道 PCM。
 *
 * 实时识别需要的是连续音频块，而 `MediaRecorder` 只能在停止时给出一个完整的 WebM 文件，
 * 所以这里改用 `AudioWorklet` 在音频线程里每 100ms 交出一块 PCM。
 */
export class Microphone {
  private context?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private silent?: GainNode;
  private disposed = false;
  private onFlushed?: () => void;

  constructor(private onChunk: (base64: string) => void) {}

  async prepare() {
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.resume();
    if (this.disposed) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (this.disposed) {
      this.stream.getTracks().forEach((track) => track.stop());
      return;
    }
    // 浏览器没有按 16kHz 打开时不能继续：采样率不符会让识别结果整体失真。
    if (this.context.sampleRate !== 16000)
      throw new Error("当前浏览器不支持 16kHz 采集，请使用新版 Chrome 或 Edge");
    await this.context.audioWorklet.addModule("/pcm-worklet.js");
  }

  start() {
    if (this.disposed || !this.context || !this.stream) return;
    this.node = new AudioWorkletNode(this.context, "pcm-capture");
    this.node.port.onmessage = ({ data }) => {
      if (data.flushed) {
        this.onFlushed?.();
        return;
      }
      if (this.disposed) return;
      const bytes = new Uint8Array(data.buffer);
      this.onChunk(btoa(String.fromCharCode(...bytes)));
    };
    this.source = this.context.createMediaStreamSource(this.stream);
    // 必须接到 destination，音频线程才会被驱动；用 0 增益避免自己听到自己的声音。
    this.silent = this.context.createGain();
    this.silent.gain.value = 0;
    this.source
      .connect(this.node)
      .connect(this.silent)
      .connect(this.context.destination);
  }

  /** 停止采集；`discard` 为真时丢弃最后不足 100ms 的音频。 */
  async stop(discard = false) {
    if (this.disposed) return;
    if (!discard && this.node) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        this.onFlushed = () => {
          clearTimeout(timer);
          resolve();
        };
        this.node!.port.postMessage("flush");
      });
    }
    this.disposed = true;
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.port.close();
    this.silent?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context?.state !== "closed") await this.context?.close();
  }
}

/** 整段录音也拥有同一套 prepare/start/finish/cancel 生命周期。 */
export class UploadRecording {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private cancelled = false;
  async prepare() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.cancelled) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
  }
  start(onComplete: (audio: Blob) => void, onError: (error: unknown) => void) {
    if (this.cancelled || !this.stream) return;
    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      const recorder = new MediaRecorder(this.stream, { mimeType });
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) this.chunks.push(event.data);
      };
      recorder.onstop = () => {
        this.release();
        if (!this.cancelled) onComplete(new Blob(this.chunks, { type: mimeType }));
        this.chunks = [];
      };
      recorder.onerror = () => {
        this.cancel();
        onError(new Error("录音失败，请重新录音"));
      };
      recorder.start();
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
  finish() {
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.release();
  }
  cancel() {
    this.cancelled = true;
    this.finish();
    this.chunks = [];
  }
  private release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}

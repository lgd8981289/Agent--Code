/** 在音频线程收集 100ms 的单声道 PCM16，避免把完整 WebM 文件误当成 PCM 音频块。 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.port.onmessage = ({ data }) => {
      if (data === "flush") {
        this.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  flush() {
    if (!this.samples.length) return;
    const buffer = new ArrayBuffer(this.samples.length * 2);
    const view = new DataView(buffer);
    let power = 0;
    this.samples.forEach((sample, index) => {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      power += value * value;
    });
    this.port.postMessage({ buffer, level: Math.sqrt(power / this.samples.length) }, [
      buffer,
    ]);
    this.samples = [];
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const value of samples) {
        this.samples.push(value);
        if (this.samples.length === 1600) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);

import { test } from "node:test";
import assert from "node:assert/strict";
import { UploadRecording } from "../web/src/recorder.js";

function mediaHarness(deferred = false) {
  const saved = ["navigator", "MediaRecorder"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  let stops = 0,
    recorder: FakeRecorder | undefined,
    grant!: (stream: MediaStream) => void;
  const stream = {
    getTracks: () => [{ stop: () => stops++ }],
  } as unknown as MediaStream;
  class FakeRecorder {
    state = "inactive";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    static isTypeSupported() {
      return true;
    }
    constructor() {
      // 测试需要检查真实被创建的录音器状态。
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      recorder = this;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["audio"]) });
        this.onstop?.();
      });
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          deferred
            ? new Promise<MediaStream>((resolve) => {
                grant = resolve;
              })
            : Promise.resolve(stream),
      },
    },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeRecorder,
  });
  return {
    get stops() {
      return stops;
    },
    get recorder() {
      return recorder;
    },
    grant: () => grant(stream),
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
test("备用录音手动停止：释放音轨并只交付一次完整音频", async () => {
  const media = mediaHarness();
  try {
    const recording = new UploadRecording(),
      outputs: Blob[] = [];
    await recording.prepare();
    recording.start(
      (blob) => outputs.push(blob),
      (error) => {
        throw error;
      },
    );
    recording.finish();
    recording.finish();
    await Promise.resolve();
    assert.equal(media.recorder?.state, "inactive");
    assert.equal(media.stops, 1);
    assert.equal(outputs.length, 1);
    assert.equal(await outputs[0].text(), "audio");
  } finally {
    media.restore();
  }
});
test("取消备用录音会释放麦克风，丢弃迟到音频", async () => {
  const media = mediaHarness();
  try {
    const recording = new UploadRecording();
    let uploads = 0;
    await recording.prepare();
    recording.start(
      () => uploads++,
      (error) => {
        throw error;
      },
    );
    recording.cancel();
    await Promise.resolve();
    assert.equal(media.stops, 1);
    assert.equal(uploads, 0);
  } finally {
    media.restore();
  }
});
test("授权麦克风前取消，迟到的媒体流也会释放", async () => {
  const media = mediaHarness(true);
  try {
    const recording = new UploadRecording();
    const pending = recording.prepare();
    recording.cancel();
    media.grant();
    await pending;
    recording.start(
      () => assert.fail("不应上传"),
      (error) => {
        throw error;
      },
    );
    assert.equal(media.stops, 1);
    assert.equal(media.recorder, undefined);
  } finally {
    media.restore();
  }
});

import assert from "node:assert/strict";

/** 使用浏览器内媒体/供应商替身，验证生命周期；不会调用付费语音服务。 */
export async function verifyVoiceAndPolling(page) {
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), multimodalReady: true },
    });
  });
  await page.addInitScript(() => {
    window.recordingStats = { stopped: 0, active: 0, captures: 0 };
    window.AudioContext = class {
      constructor() {
        throw new Error("测试：强制使用后备录音");
      }
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.recordingStats.captures++;
          window.recordingStats.active++;
          let stopped = false;
          return {
            getTracks: () => [
              {
                stop() {
                  if (!stopped) {
                    stopped = true;
                    window.recordingStats.stopped++;
                    window.recordingStats.active--;
                  }
                },
              },
            ],
          };
        },
      },
    });
    window.MediaRecorder = class {
      state = "inactive";
      static isTypeSupported() {
        return true;
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
    };
  });
  let transcriptions = 0,
    releaseTranscription,
    transcriptionStarted;
  const pendingTranscription = new Promise((resolve) => {
    transcriptionStarted = resolve;
  });
  await page.route("**/api/voice/transcribe", async (route) => {
    transcriptions++;
    if (transcriptions === 2)
      await new Promise((resolve) => {
        releaseTranscription = resolve;
        transcriptionStarted();
      });
    await route.fulfill({ json: { text: "A1024 咖啡机外壳损坏" } }).catch(() => {});
  });
  await page.reload();
  const input = page.getByLabel("售后问题", { exact: true });
  await input.waitFor();
  await input.fill("保留草稿");
  await page.getByTitle("语音输入", { exact: true }).click();
  await page.getByTitle("停止并生成文字", { exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('textarea[aria-label="售后问题"]').value.includes("A1024"),
  );
  assert.equal(await input.inputValue(), "保留草稿 A1024 咖啡机外壳损坏");
  assert.deepEqual(await page.evaluate(() => window.recordingStats), {
    stopped: 1,
    active: 0,
    captures: 1,
  });
  await input.fill("取消后保留这段草稿");
  await page.getByTitle("语音输入", { exact: true }).click();
  await page.getByTitle("停止并生成文字", { exact: true }).click();
  await page.waitForFunction(() => window.recordingStats.stopped === 2);
  await pendingTranscription;
  await page.getByTitle("取消语音识别", { exact: true }).click();
  releaseTranscription?.();
  await page.waitForTimeout(100);
  assert.equal(await input.inputValue(), "取消后保留这段草稿");
  assert.equal(await page.evaluate(() => window.recordingStats.active), 0);
  await input.fill("");

  // Replay 仍走真实 SSE；TTS 用有效 WAV 字节检查原生播放器，不调用供应商。
  const wave = Buffer.alloc(44 + 24000 * 2);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(24000, 24);
  wave.writeUInt32LE(48000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  let speeches = 0,
    releaseSpeech,
    speechStarted;
  const pendingSpeech = new Promise((resolve) => {
    speechStarted = resolve;
  });
  await page.route("**/api/voice/speak", async (route) => {
    speeches++;
    if (speeches === 2)
      await new Promise((resolve) => {
        releaseSpeech = resolve;
        speechStarted();
      });
    await route.fulfill({ body: wave, contentType: "audio/wav" }).catch(() => {});
  });
  await input.fill("查询 A1024 订单实付金额");
  await page.getByTitle("发送消息", { exact: true }).click();
  await page.locator(".message.assistant").last().waitFor();
  await page.locator(".working").waitFor({ state: "hidden" });
  const speak = page.getByRole("button", { name: "朗读", exact: true }).last();
  await speak.click();
  await page.waitForFunction(() => document.querySelector("audio")?.currentTime > 0);
  assert.equal(await page.locator("audio").evaluate((audio) => audio.duration), 1);
  await page.getByRole("button", { name: "停止朗读", exact: true }).last().click();
  await speak.click();
  await pendingSpeech;
  await page.getByRole("button", { name: "取消朗读", exact: true }).click();
  releaseSpeech();
  await page.waitForTimeout(100);
  assert.equal(await page.locator("audio").count(), 0);
  await page.screenshot({ path: "test-artifacts/quality-chat.png", fullPage: true });
  // 空闲聊天页跨过两个轮询周期，不能重复拉取 Bootstrap/全部会话详情。
  const requests = [];
  const observe = (request) => {
    if (request.url().includes("/api/")) requests.push(request.url());
  };
  page.on("request", observe);
  await page.locator("h1").click();
  await page.waitForTimeout(8500);
  page.off("request", observe);
  assert.ok(
    !requests.some((url) => /\/api\/(bootstrap|conversations)(?:\?|$)/.test(url)),
    JSON.stringify(requests),
  );
  console.log(
    "PASS：备用录音停止释放音轨、取消丢弃迟到转写、原生朗读和取消、空闲聊天不全量轮询。",
  );
}

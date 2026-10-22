import { test } from "node:test";
import assert from "node:assert/strict";
import { asrConfig } from "../server/voice/asr.js";
import { normalizeOrderIds } from "../server/voice/normalize.js";
import { normalizeWav } from "../server/voice/wav.js";
import { Materials } from "../server/materials.service.js";
import type { Storage } from "../server/storage.js";

function ttsWav() {
  const wav = Buffer.alloc(48);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(0x7fffffbf, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(0x7fffff9b, 40);
  wav.writeInt16LE(1200, 44);
  return wav;
}

test("TTS 流式 WAV 占位长度转成真实长度，并拒绝空白或非音频响应", () => {
  const wav = ttsWav();
  const fixed = normalizeWav(wav);
  assert.equal(fixed.readUInt32LE(4), 40);
  assert.equal(fixed.readUInt32LE(40), 4);
  assert.equal(fixed.readInt16LE(44), 1200);
  assert.equal(wav.readUInt32LE(4), 0x7fffffbf, "不修改输入缓存");
  assert.throws(() => normalizeWav(wav.subarray(0, 44)), /为空或已损坏/);
  assert.throws(
    () => normalizeWav(Buffer.from("<Error>音频未生成</Error>")),
    /不是有效 WAV/,
  );
});

test("朗读下载返回可播放字节；下载失败、无效音频和过大文件均报告错误", async (t) => {
  const materials = new Materials({} as Storage);
  t.mock.method(materials, "speak", async () => ({
    url: "https://example.oss-cn-beijing.aliyuncs.com/audio.wav",
  }));
  let response = new Response(ttsWav(), { headers: { "Content-Type": "audio/x-wav" } });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    assert.equal(options.redirect, "error", "供应商音频地址不允许跳转到任意域名");
    return response;
  });
  const audio = await materials.speakAudio("申请待审核");
  assert.equal(audio.readUInt32LE(40), 4);
  response = new Response("Forbidden", { status: 403 });
  await assert.rejects(materials.speakAudio("申请待审核"), /音频下载失败/);
  response = new Response("<html>服务异常</html>");
  await assert.rejects(materials.speakAudio("申请待审核"), /不是有效 WAV/);
  response = new Response(new Uint8Array(16 * 1024 * 1024 + 1));
  await assert.rejects(materials.speakAudio("申请待审核"), /音频过大/);
});

test("实时识别的汉字订单号会还原成阿拉伯数字", () => {
  // 这几种写法都来自真实识别结果：逐位读、用「幺」代替「一」、带空格。
  for (const [input, expected] of [
    ["订单号A一零二四，咖啡机外壳损坏", "订单号A1024，咖啡机外壳损坏"],
    ["订单号 A 一 零 二 四，已经签收", "订单号 A1024，已经签收"],
    ["订单a幺零二四的磨豆机", "订单a1024的磨豆机"],
    ["A一零二四", "A1024"],
  ] as const)
    assert.equal(normalizeOrderIds(input), expected);
});

test("订单号还原不改动金额与普通描述", () => {
  const text = "订单号A一零二四，实付三千五百元，我要申请退款。";
  const result = normalizeOrderIds(text);
  assert.equal(result, "订单号A1024，实付三千五百元，我要申请退款。");
  // 金额由业务记录提供，这段文本里的汉字数字必须原样保留。
  assert.match(result, /三千五百元/);
  // 还原后必须能被 agent.service.ts 的抽取规则命中，否则不会生成处理建议。
  assert.equal(result.match(/A\d{4}/i)?.[0], "A1024");
});

test("基数读法不做猜测，避免把无关文本改坏", () => {
  // 真人读订单号是逐位的；「A一千零二十四」属于基数读法，规则不擅自改写。
  assert.equal(normalizeOrderIds("A一千零二十四"), "A一千零二十四");
  assert.equal(normalizeOrderIds("三千五百元"), "三千五百元");
});

test("实时识别地址必须来自同地域的兼容接口", () => {
  assert.equal(
    asrConfig({
      DASHSCOPE_API_KEY: "k",
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }).url,
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime",
  );
  // 指向控制台页面或缺少路径的地址会让连接一直失败，必须在启动前拒绝。
  for (const bad of [
    "https://dashscope.aliyuncs.com",
    "https://dashscope.aliyuncs.com/api/v1",
    "http://dashscope.aliyuncs.com/compatible-mode/v1",
  ])
    assert.throws(() => asrConfig({ DASHSCOPE_API_KEY: "k", DASHSCOPE_BASE_URL: bad }));
  assert.throws(() => asrConfig({ DASHSCOPE_API_KEY: "", DASHSCOPE_BASE_URL: "" }));
});

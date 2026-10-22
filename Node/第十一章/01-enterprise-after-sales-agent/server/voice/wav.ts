/** 部分 TTS 返回流式 WAV 长度占位值。完整下载后填入实际长度，供浏览器解码和定位。 */
export function normalizeWav(input: Buffer): Buffer {
  if (
    input.length < 44 ||
    input.toString("ascii", 0, 4) !== "RIFF" ||
    input.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("语音服务返回的音频不是有效 WAV");
  const bytes = Buffer.from(input);
  let hasFormat = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (kind === "fmt ") hasFormat = size >= 16 && offset + 8 + size <= bytes.length;
    if (kind === "data") {
      const available = bytes.length - offset - 8;
      if (!hasFormat || !available || !size) break;
      // 标准 WAV 可能在 data 后还有其他 chunk；只修复超出文件的占位值。
      if (size > available) bytes.writeUInt32LE(available, offset + 4);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      return bytes;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("语音服务返回的音频为空或已损坏");
}

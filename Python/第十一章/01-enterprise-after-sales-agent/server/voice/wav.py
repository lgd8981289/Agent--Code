"""下载完成后修复流式 WAV 长度占位值，保留 data 后的正常 chunk。"""

import struct


def normalize_wav(content):
    if len(content) < 44 or content[:4] != b"RIFF" or content[8:12] != b"WAVE":
        raise ValueError("语音服务返回的音频不是有效 WAV")
    data, offset, has_format = bytearray(content), 12, False
    while offset + 8 <= len(data):
        kind, size = bytes(data[offset:offset+4]), struct.unpack_from("<I", data, offset+4)[0]
        if kind == b"fmt ":
            has_format = size >= 16 and offset + 8 + size <= len(data)
        if kind == b"data":
            available = len(data) - offset - 8
            if not has_format or not available or not size:
                break
            if size > available:
                struct.pack_into("<I", data, offset+4, available)
            struct.pack_into("<I", data, 4, len(data)-8)
            return bytes(data)
        offset += 8 + size + size % 2
    raise ValueError("语音服务返回的音频为空或已损坏")

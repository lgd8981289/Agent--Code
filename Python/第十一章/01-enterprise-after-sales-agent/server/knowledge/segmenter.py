"""用 ICU Word Break 复现 Intl.Segmenter('zh')，不以逐字切分替代中文词切分。

macOS 自带 ICU；Linux 使用发行版的 libicu。ICU 数据版本可能影响新词的边界，
离线对照会同时检查当前政策及常用查询的词序与 BM25 排名。
"""

import ctypes
import ctypes.util
import re
from functools import lru_cache


@lru_cache(maxsize=1)
def _api():
    path = ctypes.util.find_library("icui18n") or "/usr/lib/libicucore.A.dylib"
    try:
        lib = ctypes.CDLL(path)
    except OSError as error:
        raise RuntimeError("本地 BM25 需要 ICU，请安装系统 libicu（macOS 已内置）") from error
    suffix = re.search(r"(?:\.so\.|\.)(\d+)(?:\.|$)", path)
    def function(name, args, result):
        for candidate in [name, name + "_" + suffix[1] if suffix else name] + [name + "_" + str(i) for i in range(90, 60, -1)]:
            fn = getattr(lib, candidate, None)
            if fn is not None:
                fn.argtypes, fn.restype = args, result
                return fn
        raise RuntimeError("ICU 缺少词边界接口")
    ptr, integer = ctypes.c_void_p, ctypes.c_int32
    return (function("ubrk_open", [integer, ctypes.c_char_p, ptr, integer, ctypes.POINTER(integer)], ptr),
            function("ubrk_next", [ptr], integer), function("ubrk_getRuleStatus", [ptr], integer),
            function("ubrk_close", [ptr], None))


def tokens(text):
    open_break, next_break, status, close = _api()
    encoded = text.lower().encode("utf-16-le")
    buffer = ctypes.create_string_buffer(encoded)
    error = ctypes.c_int32(0)
    iterator = open_break(1, b"zh", buffer, len(encoded) // 2, ctypes.byref(error))
    if error.value > 0 or not iterator:
        raise RuntimeError("ICU 中文分词初始化失败")
    result, start = [], 0
    try:
        while (end := next_break(iterator)) != -1:
            if status(iterator) >= 100:
                result.append(encoded[start * 2:end * 2].decode("utf-16-le"))
            start = end
    finally:
        close(iterator)
    return result

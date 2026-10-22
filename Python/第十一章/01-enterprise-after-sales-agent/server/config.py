"""仅读取进程环境。路径从本文件定位，启动目录不会改变资料位置。"""

import os
import math
import re
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_DATABASE = "postgresql://aftersales_course:aftersales_course@127.0.0.1:5441/aftersales_agent"
DEFAULT_DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
ROOT = Path(__file__).resolve().parents[1]


class Config:
    def __init__(self, env=None, root=None):
        self.env = os.environ if env is None else env
        self.root = Path(root or self.value("PROJECT_ROOT") or ROOT).resolve()
        self.database_url = self.value("POSTGRES_URI") or DEFAULT_DATABASE
        self.port = self.configured_port("PORT", 4320)
        self.web_port = self.configured_port("WEB_PORT", 5190)
        self.model = self.value("DEEPSEEK_MODEL") or "deepseek-flash"

    def value(self, key, default=""):
        return self.env.get(key, "").strip() or default

    def configured_port(self, key, default):
        try:
            number = float(self.value(key))
            return int(number) if math.isfinite(number) and number.is_integer() and 0 < number <= 65535 else default
        except ValueError:
            return default

    @property
    def vision_model(self):
        return self.value("VISION_MODEL", "qwen3-vl-plus")

    @property
    def dashscope(self):
        # 图片与录音走兼容接口，TTS 和实时 ASR 从同一域名推导路径。
        return {"key": self.value("DASHSCOPE_API_KEY"), "baseUrl": self.value("DASHSCOPE_BASE_URL", DEFAULT_DASHSCOPE)}

    @property
    def ai_ready(self):
        return bool(self.value("DEEPSEEK_API_KEY"))

    @property
    def multimodal_ready(self):
        try:
            base = urlsplit(self.dashscope["baseUrl"])
            return bool(self.dashscope["key"] and base.scheme in ("https", "http") and base.hostname and base.path.rstrip("/") == "/compatible-mode/v1")
        except ValueError:
            return False

    @property
    def origins(self):
        return {f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in (self.port, self.web_port)} | ({self.value("PUBLIC_ORIGIN")} if self.value("PUBLIC_ORIGIN") else set())

    def inspect(self):
        errors, warnings = [], []
        for name in ("PORT", "WEB_PORT"):
            raw = self.value(name)
            if raw and self.configured_port(name, 0) == 0:
                errors.append(f"{name} 必须是 1 到 65535 之间的整数")
        try:
            db = urlsplit(self.database_url)
            valid_db = db.scheme in ("postgres", "postgresql") and bool(db.hostname)
        except ValueError:
            valid_db = False
        if not valid_db:
            errors.append("POSTGRES_URI 必须使用 postgresql:// 连接字符串")
        for name in ("DEEPSEEK_BASE_URL", "DASHSCOPE_BASE_URL"):
            raw = self.value(name)
            if raw:
                try:
                    url = urlsplit(raw)
                    valid_url = url.scheme in ("http", "https") and bool(url.hostname)
                except ValueError:
                    valid_url = False
                if not valid_url:
                    warnings.append(f"{name} 不是有效的 HTTP(S) 地址")
        try:
            dash = urlsplit(self.dashscope["baseUrl"])
            if dash.path.rstrip("/") != "/compatible-mode/v1":
                warnings.append("DASHSCOPE_BASE_URL 应指向兼容接口的 /compatible-mode/v1 路径")
            if not re.fullmatch(r"(?:dashscope(?:-intl)?\.aliyuncs\.com|[\w-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)", dash.hostname or ""):
                warnings.append("DASHSCOPE_BASE_URL 不是百炼的兼容接口域名，请从控制台复制完整地址")
        except ValueError:
            pass
        if self.value("DASHSCOPE_BASE_URL") and not self.value("DASHSCOPE_API_KEY"):
            warnings.append("已配置 DASHSCOPE_BASE_URL，但缺少 DASHSCOPE_API_KEY，多模态入口不可用")
        model = self.value("DEEPSEEK_MODEL")
        if model and model not in ("deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"):
            warnings.append(f"DEEPSEEK_MODEL={model} 不在课程验证过的模型名称中，请确认供应商仍支持它")
        return {"errors": errors, "warnings": warnings}

"""快照只读取明确的源码后缀与锁文件，不扫描环境文件或依赖目录。"""

from ..common import dumps, sha
from ..config import ROOT
from ..agent_service import CONSULTATION_PROMPT, CONSULTATION_SAFETY
from .ai_suite import AI_DATASET


def evaluation_snapshot(config, policies, mode, model, prompt=None):
    files = [ROOT / "uv.lock", ROOT / "pyproject.toml"]
    for name in ("server", "shared", "mcp_server"):
        files.extend((ROOT / name).rglob("*.py"))
    files.extend((ROOT / "server/skills").rglob("SKILL.md"))
    source = [[str(p.relative_to(ROOT)), p.read_text()] for p in sorted(files)]
    prompt = prompt or CONSULTATION_PROMPT
    return dict(datasetVersion="aftersales-2026-10-21-v2", datasetHash=sha(dumps({"replay": "business-regression-v2-10-cases", "ai": AI_DATASET if mode == "ai" else []})),
        codeHash=sha(dumps(source)), knowledgeHash=sha(dumps(policies)), model=model if mode == "ai" else "none", judgeModel=model if mode == "ai" else "none",
        prompt=prompt, safetyPrompt=CONSULTATION_SAFETY, promptHash=sha(dumps([prompt, CONSULTATION_SAFETY])), knowledgeBackend=config.value("KNOWLEDGE_BACKEND", "local") if mode == "ai" else "local",
        retrievalConfig=dict(embeddingModel=config.value("EMBEDDING_MODEL", "embedding-3"), embeddingDimensions=int(config.value("EMBEDDING_DIMENSIONS", "512")), rerankModel=config.value("RERANK_MODEL", "rerank"), collection=config.value("AFTERSALES_POLICY_COLLECTION", "aftersales_policies_v1")))

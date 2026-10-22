"""诊断轨迹不参与业务事务；保存失败不覆盖成功结果或原始异常。"""

import logging
from time import monotonic
from langchain_core.load import dumpd
from .common import now, uid


class Traces:
    def __init__(self, db):
        self.db = db

    async def run(self, scope, kind, name, input, fn):
        id, start, status, output = uid(), monotonic(), "completed", None
        try:
            output = await fn(id)
            return output
        except BaseException as error:
            status, output = "failed", {"error": str(error) or "任务已取消"}
            raise
        finally:
            try:
                actor = scope["actor"]
                await self.db.put("trace", dict(id=id, tenantId=actor["tenantId"], userId=actor["id"],
                    conversationId=scope.get("conversationId"), caseId=scope.get("caseId"), parentId=scope.get("parentId"),
                    kind=kind, name=name, input=dumpd(input), output=dumpd(output), status=status,
                    durationMs=round((monotonic() - start) * 1000), at=now()))
            except Exception as error:
                logging.warning("Trace 保存失败：%s %s", id, error)

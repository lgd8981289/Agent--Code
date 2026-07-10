"""业务异常定义。

这些异常让 service 层不直接依赖 FastAPI，离线单元测试也可以复用同一套逻辑。
"""


class KnowledgeBaseError(Exception):
    """企业知识库统一异常基类。"""

    status_code = 500

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class BadRequestError(KnowledgeBaseError):
    status_code = 400


class UnauthorizedError(KnowledgeBaseError):
    status_code = 401


class ForbiddenError(KnowledgeBaseError):
    status_code = 403


class NotFoundError(KnowledgeBaseError):
    status_code = 404


class ServiceUnavailableError(KnowledgeBaseError):
    status_code = 503


"""FastAPI 入口，监听本机；启动时初始化 PostgreSQL 并恢复已批准的任务。"""

import logging
from contextlib import asynccontextmanager
import uvicorn
from fastapi import FastAPI, WebSocket, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from .app_controller import create_router
from .application_factory import create_application
from .auth import Auth
from .common import AppError, cleanup_resources
from .config import Config
from .evaluation_service import Evaluations
from .knowledge_service import Knowledge
from .mcp import McpBridge
from .storage import Storage
from .voice.voice_gateway import VoiceGateway


class RequestBoundary:
    def __init__(self, app, config):
        self.app, self.config = app, config

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        origin = headers.get(b"origin", b"").decode()
        if scope["method"] != "GET" and origin and origin not in self.config.origins:
            return await JSONResponse({"message": "不允许的请求来源"}, status_code=403)(scope, receive, send)
        limit = 9*1024*1024 if headers.get(b"content-type", b"").startswith(b"multipart/form-data") else 100*1024
        content = bytearray()
        while True:
            event = await receive()
            if event["type"] == "http.disconnect":
                return
            content.extend(event.get("body", b""))
            if len(content) > limit:
                return await JSONResponse({"message": "请求体超过大小限制"}, status_code=413)(scope, receive, send)
            if not event.get("more_body", False):
                break
        delivered = False
        async def buffered():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(content), "more_body": False}
            return await receive()
        async def safe_send(event):
            if event["type"] == "http.response.start":
                event["headers"].append((b"x-content-type-options", b"nosniff"))
            await send(event)
        return await self.app(scope, buffered, safe_send)


def create_app(*, config=None, db=None, mcp=None, knowledge=None, model_factory=None, http=None, evaluations=None):
    config = config or Config()
    own_db, own_mcp, own_knowledge = db is None, mcp is None, knowledge is None
    db, mcp, knowledge = db or Storage(config.database_url), mcp or McpBridge(config), knowledge or Knowledge(config)
    system = create_application(db, mcp, knowledge, config, model_factory, http)
    auth = Auth(db, config)
    gateway = VoiceGateway(auth, config)
    evaluations = evaluations or Evaluations(db, config, model_factory)

    @asynccontextmanager
    async def lifespan(app):
        try:
            if own_db:
                await db.open()
                await db.setup()
            await system.workflow.initialize()
            yield
        finally:
            actions = [gateway.close, system.workflow.close]
            actions += [r.close for flag, r in ((own_knowledge, knowledge), (own_mcp, mcp), (own_db, db)) if flag]
            for error in await cleanup_resources(actions):
                logging.warning("关闭资源失败：%s", error)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.system, app.state.auth, app.state.gateway = system, auth, gateway
    app.add_middleware(RequestBoundary, config=config)
    async def errors(request: Request, error):
        if isinstance(error, (ValidationError, RequestValidationError)):
            message = "；".join(".".join(map(str, i["loc"])) + ": " + i["msg"] for i in error.errors())
            status = 400
        elif isinstance(error, HTTPException):
            message, status = str(error.detail), error.status_code
        else:
            message, status = str(error) or "请求失败", error.status if isinstance(error, AppError) else 400 if isinstance(error, ValueError) else 500
        return JSONResponse({"message": message}, status_code=status)
    for kind in (Exception, AppError, ValueError, HTTPException, ValidationError, RequestValidationError):
        app.add_exception_handler(kind, errors)
    app.include_router(create_router(system, auth, evaluations, config))
    @app.websocket("/api/voice")
    async def voice(socket: WebSocket):
        await gateway.handle(socket)
    if config.value("NODE_ENV") == "production" and (config.root / "web/dist").is_dir():
        app.mount("/", StaticFiles(directory=config.root / "web/dist", html=True))
    return app


def main():
    config = Config()
    report = config.inspect()
    for warning in report["warnings"]:
        logging.warning("配置提示：%s", warning)
    if report["errors"]:
        raise SystemExit("启动失败：" + "；".join(report["errors"]))
    print(f"售后 Agent API：http://127.0.0.1:{config.port}；页面：http://127.0.0.1:{config.web_port}")
    uvicorn.run(create_app(config=config), host="127.0.0.1", port=config.port, ws="websockets-sansio", ws_max_size=256*1024)


if __name__ == "__main__":
    main()

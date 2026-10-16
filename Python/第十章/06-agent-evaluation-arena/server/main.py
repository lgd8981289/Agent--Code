"""FastAPI HTTP 入口；仅监听回环地址，保持原课程的 /api 接口。"""

from contextlib import asynccontextmanager
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

from server.arena_service import ArenaError, ArenaService
from server.json_helpers import loads
from server.runner import RunnerService
from shared.contracts import SchemaError


class LocalOnly:
    """本地教学服务的 Host/Origin 与 2 MiB 请求体边界，不替代生产身份认证。"""

    def __init__(self, app, port, web_port):
        self.app = app
        self.origins = {f"http://{host}:{value}" for host in ("localhost", "127.0.0.1") for value in (web_port, port)}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        host = headers.get(b"host", b"").decode("latin1").split(":")[0]
        origin = headers.get(b"origin", b"").decode("latin1")
        message = "仅允许本机访问" if host not in ("localhost", "127.0.0.1") else "请求来源不允许" if origin and origin not in self.origins else None
        if message:
            return await JSONResponse({"message": message}, status_code=403)(scope, receive, send)
        # 按接收字节累计，不信任 Content-Length，流式上传也受同一大小限制。
        body = bytearray()
        while True:
            event = await receive()
            if event["type"] == "http.disconnect":
                return
            body.extend(event.get("body", b""))
            if len(body) > 2 * 1024 * 1024:
                return await JSONResponse({"message": "请求体超过 2 MiB"}, status_code=413)(scope, receive, send)
            if not event.get("more_body", False):
                break
        delivered = False

        async def buffered_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()
        await self.app(scope, buffered_receive, send)


def create_app(*, env=None, directory=None, runner=None, replay_delay=.1):
    environment = os.environ if env is None else env
    port = int(environment.get("PORT") or 4318)

    @asynccontextmanager
    async def lifespan(app):
        # 导入模块不创建数据文件；真正启动服务时才初始化依赖与持久化。
        app.state.arena = ArenaService(runner or RunnerService(environment), directory, env=environment, replay_delay=replay_delay)
        try:
            yield
        finally:
            await app.state.arena.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LocalOnly, port=port, web_port=int(environment.get("ARENA_WEB_PORT") or 5188))

    @app.exception_handler(SchemaError)
    async def invalid_input(_, error):
        return JSONResponse({"message": str(error)}, status_code=400)

    @app.exception_handler(ArenaError)
    async def arena_error(_, error):
        return JSONResponse({"message": str(error)}, status_code=error.status)

    async def body(request):
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise SchemaError("请求体必须使用 application/json")
        try:
            return loads(await request.body())
        except (ValueError, UnicodeDecodeError) as error:
            raise SchemaError("请求体必须是合法 JSON") from error

    # 端点保持异步：服务方法中的任务调度必须运行在主事件循环，不放到线程池。
    @app.get("/api/meta")
    async def meta(request: Request):
        return request.app.state.arena.meta()

    @app.get("/api/runs")
    async def history(request: Request):
        return request.app.state.arena.list()

    @app.get("/api/runs/{batch_id}")
    async def get_run(batch_id: str, request: Request):
        return request.app.state.arena.get(batch_id)

    @app.post("/api/runs", status_code=201)
    async def create_run(request: Request):
        return request.app.state.arena.create(await body(request))

    @app.post("/api/runs/{batch_id}/cancel", status_code=201)
    async def cancel(batch_id: str, request: Request):
        return request.app.state.arena.cancel(batch_id)

    @app.post("/api/runs/{batch_id}/gate", status_code=201)
    async def gate(batch_id: str, request: Request):
        return request.app.state.arena.gate(batch_id)

    @app.post("/api/runs/{batch_id}/reviews/{result_id}", status_code=201)
    async def review(batch_id: str, result_id: str, request: Request):
        return request.app.state.arena.review(batch_id, result_id, await body(request))

    @app.post("/api/versions", status_code=201)
    async def version(request: Request):
        return request.app.state.arena.version(await body(request))

    @app.delete("/api/versions/{version_id}")
    async def delete_version(version_id: str, request: Request):
        return request.app.state.arena.delete_version(version_id)

    @app.post("/api/datasets", status_code=201)
    async def dataset(request: Request):
        return request.app.state.arena.import_dataset(await body(request))
    return app


def main():
    port = int(os.environ.get("PORT") or 4318)
    web_port = int(os.environ.get("ARENA_WEB_PORT") or 5188)
    print(f"评测服务：http://127.0.0.1:{port}；页面：http://localhost:{web_port}")
    # 不自动加载任何环境文件；单进程保证一个批次的互斥与 Worker 队列有效。
    uvicorn.run(create_app(), host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()

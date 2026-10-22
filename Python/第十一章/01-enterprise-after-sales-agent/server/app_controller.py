"""HTTP 与 SSE 适配；沿用 Vue 页面的所有 /api 请求及事件格式。"""

import asyncio
from uuid import UUID
import anyio
from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from . import schemas as s
from .common import dumps, require
from .domain import assert_customer, assert_reviewer
from .fixtures import ACCOUNTS


async def body(request, schema):
    require(request.headers.get("content-type", "").split(";")[0].strip() == "application/json", "请求体必须使用 application/json")
    try:
        value = await request.json()
    except ValueError as error:
        raise ValueError("请求体必须是合法 JSON") from error
    return schema.model_validate(value)


async def upload(request, limit):
    async with request.form(max_files=1, max_fields=8, max_part_size=limit) as form:
        file = form.get("file")
        require(file and hasattr(file, "read"), "请选择材料文件")
        content = await file.read(limit+1)
        require(len(content) <= limit, "上传文件超过大小限制", 413)
        return content, file.filename or "材料", file.content_type or "application/octet-stream"


async def until_disconnect(request, coroutine):
    """请求体读完以后监听断开，取消云端请求；不把付费任务留在后台运行。"""
    task = asyncio.create_task(coroutine)
    async def disconnected():
        while True:
            event = await request.receive()
            if event["type"] == "http.disconnect":
                return
    monitor = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait([task, monitor], return_when=asyncio.FIRST_COMPLETED)
        if task in done:
            return await task
        task.cancel()
        raise asyncio.CancelledError()
    finally:
        monitor.cancel()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, monitor, return_exceptions=True)


def create_router(system, auth, evaluations, config):
    router, app = APIRouter(prefix="/api"), system.app

    @router.get("/health")
    async def health():
        return {"ok": True, "service": "aftersales-agent"}

    @router.get("/meta")
    async def meta():
        return dict(accounts=ACCOUNTS, aiReady=config.ai_ready, multimodalReady=config.multimodal_ready)

    @router.post("/login", status_code=201)
    async def login(request: Request, response: Response):
        return await auth.login((await body(request, s.Login)).accountId, response)

    @router.get("/bootstrap")
    async def bootstrap(request: Request):
        return await app.bootstrap(await auth.actor(request))

    @router.get("/conversations")
    async def conversations(request: Request):
        return await app.conversation_summaries(await auth.actor(request))

    @router.post("/conversations", status_code=201)
    async def create(request: Request):
        actor = await auth.actor(request)
        return await app.create_conversation(actor, (await body(request, s.Create)).mode)

    @router.get("/conversations/{id}")
    async def conversation(id: UUID, request: Request):
        return await app.conversation(await auth.actor(request), str(id))

    @router.post("/conversations/{id}/rename", status_code=201)
    async def rename(id: UUID, request: Request):
        return await app.rename_conversation(await auth.actor(request), str(id), (await body(request, s.Rename)).title)

    @router.post("/conversations/{id}/delete", status_code=201)
    async def delete(id: UUID, request: Request):
        return await app.set_conversation_deleted(await auth.actor(request), str(id), True)

    @router.post("/conversations/{id}/restore", status_code=201)
    async def restore(id: UUID, request: Request):
        return await app.set_conversation_deleted(await auth.actor(request), str(id), False)

    @router.post("/conversations/{id}/messages", status_code=201)
    async def send(id: UUID, request: Request):
        actor, input = await auth.actor(request), await body(request, s.Send)
        return await app.send(actor, str(id), input.message)

    @router.post("/conversations/{id}/messages/stream")
    async def stream_messages(id: UUID, request: Request):
        actor, input = await auth.actor(request), await body(request, s.Send)
        assert_customer(actor)
        await app.conversation(actor, str(id))
        async def stream():
            queue = asyncio.Queue()
            async def run():
                try:
                    queue.put_nowait({"type": "status", "message": "正在核对订单与资料…"})
                    result = await app.send(actor, str(id), input.message, queue.put_nowait)
                    queue.put_nowait({"type": "done", "conversation": result})
                except Exception as error:
                    queue.put_nowait({"type": "error", "message": str(error)})
                finally:
                    queue.put_nowait(None)
            task = asyncio.create_task(run())
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), 15)
                    except asyncio.TimeoutError:
                        yield ": heartbeat\n\n"
                        continue
                    if event is None:
                        break
                    yield "data: " + dumps(event) + "\n\n"
            finally:
                task.cancel()
                with anyio.CancelScope(shield=True):
                    await asyncio.gather(task, return_exceptions=True)
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    @router.get("/conversations/{id}/materials")
    async def materials(id: UUID, request: Request):
        return await app.material_list(await auth.actor(request), str(id))

    @router.post("/conversations/{id}/materials", status_code=201)
    async def add_material(id: UUID, request: Request):
        actor = await auth.actor(request)
        content, name, mime = await upload(request, 5*1024*1024)
        return await app.add_material(actor, str(id), content, name, mime)

    @router.post("/conversations/{id}/sample", status_code=201)
    async def sample(id: UUID, request: Request):
        return await app.add_material(await auth.actor(request), str(id), (config.root / "samples/damaged-coffee-machine.png").read_bytes(), "演示样本-咖啡机损坏.png", "image/png")

    @router.post("/materials/{id}/confirm", status_code=201)
    async def confirm(id: UUID, request: Request):
        actor, input = await auth.actor(request), await body(request, s.Confirm)
        return await app.confirm_material(actor, str(id), input.observation, input.version)

    @router.post("/materials/{id}/remove", status_code=201)
    async def remove(id: UUID, request: Request):
        actor, input = await auth.actor(request), await body(request, s.Remove)
        return await app.remove_material(actor, str(id), input.version)

    @router.get("/materials/{id}/content")
    async def content(id: UUID, request: Request):
        item = await system.materials.get(await auth.actor(request), str(id), True)
        return FileResponse(config.root / "data/materials" / item["id"], media_type=item["mime"], headers={"Cache-Control": "private, no-store"})

    @router.post("/conversations/{id}/submit", status_code=201)
    async def submit(id: UUID, request: Request):
        return await app.submit(await auth.actor(request), str(id), (await body(request, s.Submit)).model_dump())

    @router.get("/cases")
    async def cases(request: Request):
        return await app.case_page(await auth.actor(request), s.Page.model_validate(dict(request.query_params)).model_dump())

    @router.get("/cases/{id}")
    async def get_case(id: UUID, request: Request):
        return await app.get_case(await auth.actor(request), str(id))

    @router.get("/cases/{id}/materials")
    async def case_materials(id: UUID, request: Request):
        actor = await auth.actor(request)
        item = await app.get_case(actor, str(id))
        snapshots = item.get("history", [])[-1].get("materials", []) if item.get("history") else []
        result = []
        for material_id in item["materialIds"]:
            material = await system.materials.get(actor, material_id, True)
            snapshot = next((m for m in snapshots if m["id"] == material_id), None)
            result.append({**material, "observation": snapshot["observation"]} if snapshot else material)
        return result

    @router.post("/cases/{id}/revise", status_code=201)
    async def revise(id: UUID, request: Request):
        return await app.revise(await auth.actor(request), str(id), (await body(request, s.Mutation)).model_dump())

    @router.post("/cases/{id}/review", status_code=201)
    async def review(id: UUID, request: Request):
        return await app.review(await auth.actor(request), str(id), (await body(request, s.Review)).model_dump())

    @router.post("/cases/{id}/retry", status_code=201)
    async def retry(id: UUID, request: Request):
        return await app.retry(await auth.actor(request), str(id))

    @router.post("/cases/{id}/cancel", status_code=201)
    async def cancel(id: UUID, request: Request):
        actor, input = await auth.actor(request), await body(request, s.Cancel)
        return await app.cancel(actor, str(id), input.version, input.reason)

    @router.post("/cases/{id}/investigate", status_code=201)
    async def investigate(id: UUID, request: Request):
        return await app.investigate(await auth.actor(request), str(id), (await body(request, s.Create)).mode)

    @router.get("/cases/{id}/report")
    async def report(id: UUID, request: Request):
        actor = await auth.actor(request)
        item = await app.get_case(actor, str(id))
        return JSONResponse({"application": item, "traces": await app.traces(actor, str(id), "case")}, headers={"Content-Disposition": f'attachment; filename="{item["number"]}-report.json"'})

    @router.get("/cases/{id}/traces")
    async def case_traces(id: UUID, request: Request):
        return await app.traces(await auth.actor(request), str(id), "case")

    @router.get("/conversations/{id}/traces")
    async def traces(id: UUID, request: Request):
        return await app.traces(await auth.actor(request), str(id), "conversation")

    @router.post("/preferences", status_code=201)
    async def preference(request: Request):
        actor = await auth.actor(request)
        assert_customer(actor)
        return await system.memory.save(actor, (await body(request, s.Preference)).value)

    @router.post("/preferences/forget", status_code=201)
    async def forget(request: Request):
        actor = await auth.actor(request)
        assert_customer(actor)
        return await system.memory.forget(actor)

    @router.post("/voice/transcribe", status_code=201)
    async def transcribe(request: Request):
        await auth.actor(request)
        content, _, mime = await upload(request, 8*1024*1024)
        return await until_disconnect(request, system.materials.transcribe(content, mime))

    @router.post("/voice/speak")
    async def speak(request: Request):
        await auth.actor(request)
        audio = await until_disconnect(request, system.materials.speak_audio((await body(request, s.Speak)).text))
        return Response(audio, media_type="audio/wav", headers={"Cache-Control": "private, no-store"})

    @router.get("/evaluations")
    async def reports(request: Request):
        actor = await auth.actor(request)
        assert_reviewer(actor)
        return await evaluations.list(actor)

    @router.post("/evaluations", status_code=201)
    async def evaluate(request: Request):
        actor = await auth.actor(request)
        assert_reviewer(actor)
        input = await body(request, s.Evaluate)
        return await evaluations.run(actor, input.version, input.model_dump(exclude_none=True))

    @router.post("/conversations/{id}/judge", status_code=201)
    async def judge(id: UUID, request: Request):
        actor = await auth.actor(request)
        return await evaluations.judge(await app.conversation(actor, str(id)), await app.traces(actor, str(id), "conversation"))
    return router

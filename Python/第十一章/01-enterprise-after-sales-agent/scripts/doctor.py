"""检查进程配置、数据库与内置资源；只在 --models 时查询模型目录。"""

import argparse
import asyncio
import httpx
from server.config import Config
from server.storage import Storage
from server.knowledge_service import Knowledge


async def main(models=False):
    config = Config()
    report = config.inspect()
    failed = bool(report["errors"])
    for message in report["errors"] + report["warnings"]:
        print(message)
    db = Storage(config.database_url)
    try:
        await db.open()
        await db.query("SELECT 1")
        print("✓ PostgreSQL 连接成功")
    except Exception as error:
        failed = True
        print(f"✗ PostgreSQL：{error}；请先启动本节数据库")
    finally:
        await db.close()
    knowledge = Knowledge(config)
    if not (config.root / "samples/damaged-coffee-machine.png").is_file():
        failed = True
        print("✗ 缺少演示照片")
    else:
        print(f"✓ 演示照片与 {len(knowledge.policies)} 份政策已准备")
    print(f"真实模型：{'已配置' if config.ai_ready else '未配置（可使用 Replay）'} · {config.model}")
    print(f"图片与语音：{'已配置' if config.multimodal_ready else '未完整配置'}；视觉模型：{config.vision_model}")
    if models:
        credentials = config.dashscope
        if not credentials["key"]:
            failed = True
            print("✗ 无法检查模型目录：缺少 DASHSCOPE_API_KEY")
        else:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    response = await client.get(credentials["baseUrl"].rstrip("/") + "/models", headers={"Authorization": f"Bearer {credentials['key']}"})
                    response.raise_for_status()
                    available = any(m["id"] == config.vision_model for m in response.json()["data"])
                print("✓ 当前目录包含视觉模型，图片请求仍需实际验证" if available else "✗ 当前目录未列出配置的视觉模型，请核对地址和权限")
                failed |= not available
            except Exception:
                failed = True
                print("✗ 无法查询模型目录，请核对地址和权限")
    return int(failed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", action="store_true")
    raise SystemExit(asyncio.run(main(parser.parse_args().models)))

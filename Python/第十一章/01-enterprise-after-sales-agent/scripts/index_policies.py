"""显式执行收费 Embedding/Rerank 后端的政策索引，不覆盖其他章节的集合。"""

import asyncio
from server.config import Config
from server.knowledge.catalog import load_catalog
from server.knowledge.milvus import MilvusPolicies


async def main():
    config = Config()
    adapter = MilvusPolicies.connect(config)
    try:
        policies = load_catalog(config.root)
        await adapter.index(policies)
        print(f"已同步 {len(policies)} 份政策到 {adapter.collection}；重启应用以使用同一目录版本。")
    finally:
        await adapter.close()


if __name__ == "__main__":
    asyncio.run(main())

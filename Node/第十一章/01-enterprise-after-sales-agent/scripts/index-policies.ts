import { policies } from "../server/knowledge/catalog.js";
import { MilvusPolicies } from "../server/knowledge/milvus.js";
const adapter = MilvusPolicies.connect();
try {
  await adapter.index(policies);
  console.log(
    `已同步 ${policies.length} 份政策到 ${adapter.collection}；重启应用以使用同一目录版本。`,
  );
} finally {
  await adapter.close();
}

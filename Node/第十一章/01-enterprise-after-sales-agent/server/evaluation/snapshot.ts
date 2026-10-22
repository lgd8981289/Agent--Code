import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../config.js";
import { policies } from "../knowledge/catalog.js";
import { aiDataset } from "./ai-suite.js";
import { CONSULTATION_PROMPT, CONSULTATION_SAFETY } from "../agent.service.js";
import type { Mode } from "../../shared/types.js";
const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export async function evaluationSnapshot(
  mode: Mode,
  model: string,
  prompt = CONSULTATION_PROMPT,
) {
  const files = ["package-lock.json"];
  for (const dir of ["server", "shared", "mcp"])
    files.push(
      ...(await readdir(join(root, dir), { recursive: true }))
        .filter((p) => p.endsWith(".ts"))
        .map((p) => `${dir}/${p}`),
    );
  const source = await Promise.all(
    files.sort().map(async (p) => [p, await readFile(join(root, p), "utf8")]),
  );
  return {
    datasetVersion: "aftersales-2026-10-21-v2",
    datasetHash: hash({
      replay: "business-regression-v2-10-cases",
      ai: mode === "ai" ? aiDataset : [],
    }),
    codeHash: hash(source),
    knowledgeHash: hash(policies),
    model: mode === "ai" ? model : "none",
    judgeModel: mode === "ai" ? model : "none",
    prompt,
    safetyPrompt: CONSULTATION_SAFETY,
    promptHash: hash([prompt, CONSULTATION_SAFETY]),
    retrievalConfig: {
      embeddingModel: process.env.EMBEDDING_MODEL || "embedding-3",
      embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS || 512),
      rerankModel: process.env.RERANK_MODEL || "rerank",
      collection: process.env.AFTERSALES_POLICY_COLLECTION || "aftersales_policies_v1",
    },
    knowledgeBackend:
      mode === "ai" ? process.env.KNOWLEDGE_BACKEND || "local" : "local",
  };
}

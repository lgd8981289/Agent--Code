import { Storage } from "./storage.js";
import { McpBridge } from "./mcp.js";
import { Knowledge } from "./knowledge.service.js";
import { MaterialRepository, CaseRepository } from "./repositories.js";
import { Traces } from "./trace.js";
import { Memories } from "./memory.service.js";
import { Materials } from "./materials.service.js";
import { ConsultationAgent } from "./agent.service.js";
import { RefundWorkflow } from "./workflow.js";
import { Investigator } from "./investigation.service.js";
import { CaseService } from "./case.service.js";
import { ApplicationService } from "./app.service.js";

/** 隔离评测和测试的组合入口；生产环境由 modules.ts 注入相同的依赖。 */
export function createApplication(db: Storage, mcp: McpBridge, knowledge: Knowledge) {
  const materialRepository = new MaterialRepository(db),
    caseRepository = new CaseRepository(db);
  const trace = new Traces(db),
    memory = new Memories(db),
    materials = new Materials(db);
  const agent = new ConsultationAgent(
    db,
    mcp,
    knowledge,
    memory,
    trace,
    materialRepository,
    caseRepository,
  );
  const workflow = new RefundWorkflow(db, mcp, trace),
    investigator = new Investigator(trace);
  const cases = new CaseService(
    db,
    mcp,
    knowledge,
    workflow,
    trace,
    investigator,
    materialRepository,
    caseRepository,
  );
  const app = new ApplicationService(
    db,
    memory,
    materials,
    agent,
    cases,
    knowledge,
    materialRepository,
  );
  return { app, agent, workflow, materials, memory, trace, cases, investigator };
}

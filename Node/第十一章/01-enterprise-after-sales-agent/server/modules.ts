import { Module } from "@nestjs/common";
import { Storage } from "./storage.js";
import { Auth } from "./auth.js";
import { McpBridge } from "./mcp.js";
import { Traces } from "./trace.js";
import { MaterialRepository, CaseRepository } from "./repositories.js";
import { Knowledge } from "./knowledge.service.js";
import { Materials } from "./materials.service.js";
import { Memories } from "./memory.service.js";
import { ConsultationAgent } from "./agent.service.js";
import { RefundWorkflow } from "./workflow.js";
import { Investigator } from "./investigation.service.js";
import { CaseService } from "./case.service.js";
import { ApplicationService } from "./app.service.js";
import { Evaluations } from "./evaluation.service.js";
import { VoiceGateway } from "./voice/voice.gateway.js";
import { AppController } from "./app.controller.js";

@Module({
  providers: [Storage, Auth, McpBridge, Traces, MaterialRepository, CaseRepository],
  exports: [Storage, Auth, McpBridge, Traces, MaterialRepository, CaseRepository],
})
export class InfrastructureModule {}

@Module({ providers: [Knowledge], exports: [Knowledge] })
export class KnowledgeModule {}

@Module({
  imports: [InfrastructureModule, KnowledgeModule],
  providers: [RefundWorkflow, Investigator, CaseService],
  exports: [RefundWorkflow, Investigator, CaseService],
})
export class AfterSalesModule {}

@Module({
  imports: [InfrastructureModule, KnowledgeModule, AfterSalesModule],
  providers: [Materials, Memories, ConsultationAgent, ApplicationService],
  exports: [Materials, Memories, ConsultationAgent, ApplicationService],
})
export class ConversationModule {}

@Module({
  imports: [InfrastructureModule],
  providers: [Evaluations],
  exports: [Evaluations],
})
export class EvaluationModule {}

@Module({
  imports: [InfrastructureModule, ConversationModule, EvaluationModule],
  controllers: [AppController],
  providers: [VoiceGateway],
})
export class AppModule {}

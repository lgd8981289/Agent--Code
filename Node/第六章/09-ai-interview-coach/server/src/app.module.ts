import { Module } from '@nestjs/common'
import { AppController } from './app.controller.js'
import { DemoAuthGuard } from './auth/demo-auth.guard.js'
import { InterviewController } from './interview/interview.controller.js'
import { InterviewGraphService } from './interview/interview-graph.service.js'
import { InterviewKnowledgeService } from './interview/knowledge.service.js'
import { InterviewMemoryService } from './interview/memory.service.js'
import { InterviewModelService } from './interview/model.service.js'
import { InterviewService } from './interview/interview.service.js'
import { StorageService } from './storage/storage.service.js'

@Module({
	controllers: [AppController, InterviewController],
	providers: [
		StorageService,
		DemoAuthGuard,
		InterviewMemoryService,
		InterviewKnowledgeService,
		InterviewModelService,
		InterviewGraphService,
		InterviewService
	]
})
export class AppModule {}

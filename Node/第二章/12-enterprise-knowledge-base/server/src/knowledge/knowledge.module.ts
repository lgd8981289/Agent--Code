import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { KnowledgeController } from './knowledge.controller.js'
import { KnowledgeService } from './knowledge.service.js'

@Module({
	imports: [AuthModule],
	controllers: [KnowledgeController],
	providers: [KnowledgeService]
})
export class KnowledgeModule {}

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AiModule } from './ai/ai.module.js'
import { AuthModule } from './auth/auth.module.js'
import { DocumentsModule } from './documents/documents.module.js'
import { HealthController } from './health.controller.js'
import { KnowledgeModule } from './knowledge/knowledge.module.js'
import { MilvusModule } from './milvus/milvus.module.js'

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		AuthModule,
		MilvusModule,
		AiModule,
		DocumentsModule,
		KnowledgeModule
	],
	controllers: [HealthController]
})
export class AppModule {}

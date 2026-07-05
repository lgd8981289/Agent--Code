import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { DocumentController } from './document.controller.js'
import { DocumentService } from './document.service.js'

@Module({
	imports: [AuthModule],
	controllers: [DocumentController],
	providers: [DocumentService],
	exports: [DocumentService]
})
export class DocumentsModule {}

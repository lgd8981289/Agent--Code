import { Global, Module } from '@nestjs/common'
import { MilvusService } from './milvus.service.js'

@Global()
@Module({
	providers: [MilvusService],
	exports: [MilvusService]
})
export class MilvusModule {}

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'

export const DEFAULT_POSTGRES_URI =
	'postgresql://interview_course:interview_course@localhost:5434/interview_coach'

/** 统一管理短期状态和长期记忆使用的 PostgreSQL 连接。 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
	readonly uri = process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
	readonly checkpointer = PostgresSaver.fromConnString(this.uri)
	readonly store = PostgresStore.fromConnString(this.uri, {
		ensureTables: false
	})

	async onModuleInit() {
		await this.checkpointer.setup()
		await this.store.setup()
	}

	async onModuleDestroy() {
		await Promise.all([this.store.stop(), this.checkpointer.end()])
	}
}

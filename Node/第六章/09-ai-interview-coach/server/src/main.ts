import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

try {
	process.loadEnvFile()
} catch {
	// Replay 模式不需要 .env，文件不存在时可以继续启动。
}

async function bootstrap() {
	const app = await NestFactory.create(AppModule, { cors: true })
	app.setGlobalPrefix('api')
	const port = Number(process.env.PORT ?? 4310)
	await app.listen(port)
	console.log(`AI 面试教练 Server 已启动：http://localhost:${port}/api`)
}

bootstrap().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

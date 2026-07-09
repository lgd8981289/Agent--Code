import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

/**
 * 创建 NestJS 应用并注册全局 API 前缀、跨域和参数校验。
 */
async function bootstrap() {
	const app = await NestFactory.create(AppModule)

	app.setGlobalPrefix('api')
	app.enableCors({ origin: 'http://localhost:5173' })
	// 删除 DTO 中未声明的字段，并拒绝携带额外参数的请求。
	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			transform: true,
			forbidNonWhitelisted: true
		})
	)

	await app.listen(Number(process.env.PORT ?? 3000))
}

void bootstrap()

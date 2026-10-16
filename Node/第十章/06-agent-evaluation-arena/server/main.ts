import 'reflect-metadata'
import {
	Body,
	Catch,
	Controller,
	Delete,
	Get,
	Inject,
	Module,
	Param,
	Post,
	type ArgumentsHost,
	type ExceptionFilter
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import type { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { ArenaService } from './arena.service.js'
import { RunnerService } from './runner.js'

// 全局异常过滤器：捕获 Zod 参数校验错误，统一返回 HTTP 400 和错误信息。
@Catch(ZodError)
class SchemaFilter implements ExceptionFilter {
	catch(exception: ZodError, host: ArgumentsHost) {
		host
			.switchToHttp()
			.getResponse<Response>()
			.status(400)
			.json({
				message: exception.issues
					.map((i) => `${i.path.join('.')}: ${i.message}`)
					.join('; ')
			})
	}
}

// 评测系统的 API 控制器，统一使用 /api 路由前缀。
@Controller('api')
class ArenaController {
	constructor(@Inject(ArenaService) private readonly arena: ArenaService) {}

	// 获取评测系统的元信息。
	@Get('meta') meta() {
		return this.arena.meta()
	}

	// 查询历史评测任务列表。
	@Get('runs') list() {
		return this.arena.list()
	}

	// 根据任务 ID 查询评测详情。
	@Get('runs/:id') get(@Param('id') id: string) {
		return this.arena.get(id)
	}

	// 创建新的评测任务。
	@Post('runs') create(@Body() body: unknown) {
		return this.arena.create(body)
	}

	// 取消指定的评测任务。
	@Post('runs/:id/cancel') cancel(@Param('id') id: string) {
		return this.arena.cancel(id)
	}

	// 对指定评测任务执行质量门禁检查。
	@Post('runs/:id/gate') gate(@Param('id') id: string) {
		return this.arena.gate(id)
	}

	// 提交指定评测结果的人工审核信息。
	@Post('runs/:id/reviews/:resultId') review(
		@Param('id') id: string,
		@Param('resultId') resultId: string,
		@Body() body: unknown
	) {
		return this.arena.review(id, resultId, body)
	}

	// 创建新的被评测版本。
	@Post('versions') version(@Body() body: unknown) {
		return this.arena.version(body)
	}

	// 删除指定的被评测版本。
	@Delete('versions/:id') deleteVersion(@Param('id') id: string) {
		return this.arena.deleteVersion(id)
	}

	// 导入评测数据集。
	@Post('datasets') dataset(@Body() body: unknown) {
		return this.arena.importDataset(body)
	}
}

// 注册控制器和服务，由 NestJS 负责依赖注入。
@Module({
	controllers: [ArenaController],
	providers: [ArenaService, RunnerService]
})
class AppModule {}

// 读取服务端口，未配置时默认使用 4318。
const port = Number(process.env.PORT || 4318)

// 创建 NestJS 应用，并注册全局校验异常过滤器。
const app = await NestFactory.create<NestExpressApplication>(AppModule)
app.useGlobalFilters(new SchemaFilter())

// 限制 JSON 请求体大小，避免接收过大的评测数据。
app.useBodyParser('json', { limit: '2mb' })

// 请求访问限制：检查 Host 和 Origin，只允许预设的本地访问地址。
app.use((req: Request, res: Response, next: NextFunction) => {
	// 检查 Host 请求头，只接受 localhost 和 127.0.0.1。
	const host = req.headers.host?.split(':')[0]
	if (!host || !['localhost', '127.0.0.1'].includes(host))
		return res.status(403).json({ message: '仅允许本机访问' })

	// 如果请求携带 Origin，则检查是否来自允许的前端或后端端口。
	const origin = req.headers.origin
	if (
		origin &&
		![
			`http://localhost:5188`,
			`http://127.0.0.1:5188`,
			`http://localhost:${port}`,
			`http://127.0.0.1:${port}`
		].includes(origin)
	)
		return res.status(403).json({ message: '请求来源不允许' })

	// 验证通过，交给后续中间件或路由处理。
	next()
})

// 仅监听本机回环地址，不直接向外部网络开放服务。
await app.listen(port, '127.0.0.1')

// 输出后端评测服务和前端页面的访问地址。
console.log(`评测服务：http://127.0.0.1:${port}；页面：http://localhost:5188`)

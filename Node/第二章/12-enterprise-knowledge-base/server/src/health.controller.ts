import { Controller, Get } from '@nestjs/common'

@Controller('health')
export class HealthController {
	/** 返回前端和运行检查使用的服务存活状态。 */
	@Get()
	check() {
		return {
			status: 'ok',
			service: 'enterprise-knowledge-base',
			timestamp: new Date().toISOString()
		}
	}
}

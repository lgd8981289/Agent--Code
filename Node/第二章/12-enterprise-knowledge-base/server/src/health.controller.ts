import { Controller, Get } from '@nestjs/common'

@Controller('health')
export class HealthController {
	@Get()
	check() {
		return {
			status: 'ok',
			service: 'enterprise-knowledge-base',
			timestamp: new Date().toISOString()
		}
	}
}

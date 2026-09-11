import { Controller, Get } from '@nestjs/common'
import { demoUsers } from './auth/auth.types.js'

@Controller()
export class AppController {
	@Get('health')
	health() {
		return { ok: true, service: 'ai-interview-coach' }
	}

	@Get('users')
	users() {
		return demoUsers.map(({ token, ...user }) => ({ ...user, token }))
	}
}

import { Controller, Get } from '@nestjs/common'
import { DEMO_USERS } from './demo-users.js'

@Controller('session')
export class SessionController {
	@Get('users')
	listDemoUsers() {
		return DEMO_USERS
	}
}

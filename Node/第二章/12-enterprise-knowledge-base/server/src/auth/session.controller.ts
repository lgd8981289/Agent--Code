import { Controller, Get } from '@nestjs/common'
import { DEMO_USERS } from './demo-users.js'

@Controller('session')
export class SessionController {
	/** 返回前端身份切换器需要的演示用户列表。 */
	@Get('users')
	listDemoUsers() {
		return DEMO_USERS
	}
}

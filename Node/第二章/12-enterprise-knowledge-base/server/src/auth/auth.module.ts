import { Module } from '@nestjs/common'
import { AdminGuard } from './admin.guard.js'
import { DemoAuthGuard } from './demo-auth.guard.js'
import { SessionController } from './session.controller.js'

@Module({
	controllers: [SessionController],
	providers: [DemoAuthGuard, AdminGuard],
	exports: [DemoAuthGuard, AdminGuard]
})
export class AuthModule {}

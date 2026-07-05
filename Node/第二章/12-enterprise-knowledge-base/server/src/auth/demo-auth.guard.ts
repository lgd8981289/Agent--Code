import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from '@nestjs/common'
import type { Request } from 'express'
import { DEMO_USER_BY_TOKEN } from './demo-users.js'

@Injectable()
export class DemoAuthGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>()
		const authorization = request.headers.authorization
		const token = authorization?.startsWith('Bearer ')
			? authorization.slice('Bearer '.length)
			: undefined
		const user = token ? DEMO_USER_BY_TOKEN.get(token) : undefined

		if (!user) {
			throw new UnauthorizedException('请先选择一个演示身份。')
		}

		request.user = user
		return true
	}
}

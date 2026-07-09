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
	/**
	 * 根据 Bearer Token 恢复演示用户身份，并写入当前请求。
	 * 后续权限 Filter 只使用服务端确认的 user，避免信任客户端传入的租户信息。
	 */
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

		// CurrentUser 装饰器和后续 Guard 都从 request.user 读取身份。
		request.user = user
		return true
	}
}

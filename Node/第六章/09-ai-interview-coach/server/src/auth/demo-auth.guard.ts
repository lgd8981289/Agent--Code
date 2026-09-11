import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from '@nestjs/common'
import type { Request } from 'express'
import { demoUsers, type Principal } from './auth.types.js'

export interface AuthenticatedRequest extends Request {
	principal: Principal
}

/** 把演示 Token 转换成服务端可信身份，业务接口不读取用户提交的 userId。 */
@Injectable()
export class DemoAuthGuard implements CanActivate {
	canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
		const token = request.header('x-demo-token')
		const principal = demoUsers.find((user) => user.token === token)

		if (!principal) throw new UnauthorizedException('缺少有效的演示身份。')

		request.principal = principal
		return true
	}
}

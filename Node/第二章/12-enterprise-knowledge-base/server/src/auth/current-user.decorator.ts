import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

/** 从当前请求中读取已经通过 Guard 校验的用户身份。 */
export const CurrentUser = createParamDecorator(
	(_data: unknown, context: ExecutionContext) => {
		return context.switchToHttp().getRequest<Request>().user
	}
)

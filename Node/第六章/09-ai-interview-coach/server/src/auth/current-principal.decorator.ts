import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { AuthenticatedRequest } from './demo-auth.guard.js'

/** 从 Guard 已经校验过的 Request 中读取当前用户。 */
export const CurrentPrincipal = createParamDecorator(
	(_data: unknown, context: ExecutionContext) =>
		context.switchToHttp().getRequest<AuthenticatedRequest>().principal
)

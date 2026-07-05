import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

export const CurrentUser = createParamDecorator(
	(_data: unknown, context: ExecutionContext) => {
		return context.switchToHttp().getRequest<Request>().user
	}
)

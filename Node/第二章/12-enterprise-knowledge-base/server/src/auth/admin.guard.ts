import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common'
import type { Request } from 'express'

@Injectable()
export class AdminGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>()

		if (request.user?.role !== 'admin') {
			throw new ForbiddenException('只有企业管理员可以维护知识库文档。')
		}

		return true
	}
}

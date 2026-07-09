import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common'
import type { Request } from 'express'

@Injectable()
export class AdminGuard implements CanActivate {
	/** 限制文档上传和版本更新接口只能由企业管理员调用。 */
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>()

		if (request.user?.role !== 'admin') {
			throw new ForbiddenException('只有企业管理员可以维护知识库文档。')
		}

		return true
	}
}

import {
	Body,
	Controller,
	HttpCode,
	HttpStatus,
	Post,
	UseGuards
} from '@nestjs/common'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { DemoAuthGuard } from '../auth/demo-auth.guard.js'
import type { DemoUser } from '../auth/auth.types.js'
import { QueryKnowledgeDto } from './knowledge.dto.js'
import { KnowledgeService } from './knowledge.service.js'

@Controller('knowledge')
@UseGuards(DemoAuthGuard)
export class KnowledgeController {
	constructor(private readonly knowledge: KnowledgeService) {}

	@Post('query')
	@HttpCode(HttpStatus.OK)
	query(
		@CurrentUser() user: DemoUser,
		@Body() body: QueryKnowledgeDto
	) {
		return this.knowledge.query(user, body.question.trim())
	}
}

import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Param,
	Post,
	Put,
	UploadedFile,
	UseGuards,
	UseInterceptors
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { AdminGuard } from '../auth/admin.guard.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { DemoAuthGuard } from '../auth/demo-auth.guard.js'
import type { DemoUser } from '../auth/auth.types.js'
import { SaveDocumentDto } from './document.dto.js'
import { DocumentService } from './document.service.js'

@Controller('documents')
@UseGuards(DemoAuthGuard)
export class DocumentController {
	constructor(private readonly documents: DocumentService) {}

	/** 返回当前身份能够访问的生效文档。 */
	@Get()
	list(@CurrentUser() user: DemoUser) {
		return this.documents.listDocuments(user)
	}

	/** 返回指定文档的全部版本，供管理员审计和核对更新结果。 */
	@Get(':documentId/versions')
	@UseGuards(AdminGuard)
	versions(
		@CurrentUser() user: DemoUser,
		@Param('documentId') documentId: string
	) {
		return this.documents.listVersions(user, documentId)
	}

	/** 接收 Markdown 文件并创建一份新的知识文档。 */
	@Post()
	@UseGuards(AdminGuard)
	@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2_000_000 } }))
	create(
		@CurrentUser() user: DemoUser,
		@Body() body: SaveDocumentDto,
		@UploadedFile() file?: Express.Multer.File
	) {
		this.assertMarkdown(file)
		return this.documents.createDocument(user, {
			...body,
			fileName: file.originalname,
			content: file.buffer
		})
	}

	/** 接收 Markdown 文件并为已有文档发布新版本。 */
	@Put(':documentId')
	@UseGuards(AdminGuard)
	@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2_000_000 } }))
	update(
		@CurrentUser() user: DemoUser,
		@Param('documentId') documentId: string,
		@Body() body: SaveDocumentDto,
		@UploadedFile() file?: Express.Multer.File
	) {
		this.assertMarkdown(file)
		return this.documents.updateDocument(user, documentId, {
			...body,
			fileName: file.originalname,
			content: file.buffer
		})
	}

	/**
	 * 校验上传文件是否存在，并限制当前案例只处理 Markdown。
	 */
	private assertMarkdown(
		file?: Express.Multer.File
	): asserts file is Express.Multer.File {
		if (!file) throw new BadRequestException('请选择一个 Markdown 文档。')
		if (!file.originalname.toLowerCase().endsWith('.md')) {
			throw new BadRequestException('当前案例只处理 .md 文档。')
		}
	}
}

import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class SaveDocumentDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	title: string

	@IsString()
	@IsNotEmpty()
	@MaxLength(64)
	departmentId: string

	@IsIn(['company', 'department'])
	visibility: 'company' | 'department'
}

import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class QueryKnowledgeDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(1000)
	question: string
}

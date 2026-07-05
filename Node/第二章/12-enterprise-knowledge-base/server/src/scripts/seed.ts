import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module.js'
import { DEMO_USER_BY_TOKEN } from '../auth/demo-users.js'
import { DocumentService } from '../documents/document.service.js'

const samples = [
	{
		token: 'demo-bluewhale-admin',
		fileName: 'bluewhale-company-refund.md',
		title: '蓝鲸科技退款规则',
		departmentId: 'customer-service',
		visibility: 'company' as const
	},
	{
		token: 'demo-bluewhale-admin',
		fileName: 'bluewhale-customer-service.md',
		title: '客服人工审核流程',
		departmentId: 'customer-service',
		visibility: 'department' as const
	},
	{
		token: 'demo-bluewhale-admin',
		fileName: 'bluewhale-finance.md',
		title: '财务对账与大额退款规则',
		departmentId: 'finance',
		visibility: 'department' as const
	},
	{
		token: 'demo-starlight-admin',
		fileName: 'starlight-promotion.md',
		title: '星河零售会员活动',
		departmentId: 'marketing',
		visibility: 'company' as const
	}
]

async function main() {
	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: ['error', 'warn']
	})

	try {
		const documents = app.get(DocumentService)
		const sampleRoot = path.resolve(process.cwd(), '../sample-documents')

		for (const sample of samples) {
			const user = DEMO_USER_BY_TOKEN.get(sample.token)
			if (!user) throw new Error(`没有找到演示用户：${sample.token}`)

			const content = await readFile(path.join(sampleRoot, sample.fileName))
			const existing = (await documents.listDocuments(user)).find(
				(document) => document.title === sample.title
			)
			const input = {
				title: sample.title,
				departmentId: sample.departmentId,
				visibility: sample.visibility,
				fileName: sample.fileName,
				content
			}
			const result = existing
				? await documents.updateDocument(user, existing.documentId, input)
				: await documents.createDocument(user, input)

			console.log(`${sample.title}：${result.status}`)
		}
	} finally {
		await app.close()
	}
}

void main()

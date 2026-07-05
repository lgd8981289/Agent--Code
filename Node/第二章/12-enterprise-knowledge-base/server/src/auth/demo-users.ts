import type { DemoUser } from './auth.types.js'

export const DEMO_USERS: DemoUser[] = [
	{
		token: 'demo-bluewhale-admin',
		id: 'u-bluewhale-admin',
		name: '陈晨',
		tenantId: 'bluewhale',
		tenantName: '蓝鲸科技',
		departmentId: 'platform',
		departmentName: '平台管理',
		role: 'admin'
	},
	{
		token: 'demo-bluewhale-customer-service',
		id: 'u-bluewhale-customer-service',
		name: '林晓',
		tenantId: 'bluewhale',
		tenantName: '蓝鲸科技',
		departmentId: 'customer-service',
		departmentName: '客户服务部',
		role: 'employee'
	},
	{
		token: 'demo-bluewhale-finance',
		id: 'u-bluewhale-finance',
		name: '周宁',
		tenantId: 'bluewhale',
		tenantName: '蓝鲸科技',
		departmentId: 'finance',
		departmentName: '财务部',
		role: 'employee'
	},
	{
		token: 'demo-starlight-admin',
		id: 'u-starlight-admin',
		name: '许言',
		tenantId: 'starlight',
		tenantName: '星河零售',
		departmentId: 'platform',
		departmentName: '平台管理',
		role: 'admin'
	}
]

export const DEMO_USER_BY_TOKEN = new Map(
	DEMO_USERS.map((user) => [user.token, user])
)

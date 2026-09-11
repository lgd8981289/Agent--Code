export interface Principal {
	tenantId: string
	userId: string
	name: string
	token: string
}

export const demoUsers: Principal[] = [
	{
		tenantId: 'agent-course',
		userId: 'user-linxia',
		name: '林夏',
		token: 'demo-linxia'
	},
	{
		tenantId: 'agent-course',
		userId: 'user-chenzhou',
		name: '陈舟',
		token: 'demo-chenzhou'
	}
]

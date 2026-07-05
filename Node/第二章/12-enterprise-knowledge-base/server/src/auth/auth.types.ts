export type UserRole = 'admin' | 'employee'

export interface DemoUser {
	token: string
	id: string
	name: string
	tenantId: string
	tenantName: string
	departmentId: string
	departmentName: string
	role: UserRole
}

declare global {
	namespace Express {
		interface Request {
			user?: DemoUser
		}
	}
}

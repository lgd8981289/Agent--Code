import { principalsByToken } from './data.js'

/**
 * 将本地演示 token 转换为 MCP HTTP 层使用的 AuthInfo。
 */
export function authenticate(authorizationHeader) {
	const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i)
	const token = match?.[1]
	const principal = token ? principalsByToken.get(token) : undefined

	if (!token || !principal) return null

	return {
		authInfo: {
			token,
			clientId: principal.userId,
			scopes: [principal.role]
		},
		principal
	}
}

export function principalFromAuthInfo(authInfo) {
	return authInfo?.token ? principalsByToken.get(authInfo.token) : undefined
}

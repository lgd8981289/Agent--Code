/**
 * 文件作用：
 * 校验本地演示 Bearer Token，并将 Token 转换成 MCP HTTP 层使用的
 * AuthInfo 和企业用户身份。
 *
 * 章节定位：【配套文件】
 *
 * 建议阅读：
 * 了解身份如何在进入 MCP Handler 前完成校验，以及 tenantId 和 role
 * 如何从服务端身份中获得即可。
 */
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

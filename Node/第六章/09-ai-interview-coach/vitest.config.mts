import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['server/src/**/*.spec.ts'],
		environment: 'node'
	}
})

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
	root: 'web',
	plugins: [vue()],
	server: {
		port: 5180,
		proxy: {
			'/api': 'http://localhost:4310'
		}
	},
	build: {
		outDir: '../dist/web',
		emptyOutDir: true
	}
})

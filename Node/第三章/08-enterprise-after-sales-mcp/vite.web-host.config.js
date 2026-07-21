import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('./src/web-host', import.meta.url))

export default defineConfig({
	root,
	build: {
		outDir: resolve(root, '../../dist-web-host'),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				index: resolve(root, 'index.html'),
				sandbox: resolve(root, 'sandbox.html')
			}
		}
	}
})

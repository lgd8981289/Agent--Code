import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
	root: 'src/app',
	plugins: [viteSingleFile()],
	build: {
		outDir: '../../dist',
		emptyOutDir: true
	}
})

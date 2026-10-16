import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), plugins: [vue()],
  server: { host: '127.0.0.1', port: 5188, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318' } },
  build: { outDir: '../dist/web', emptyOutDir: true }
})

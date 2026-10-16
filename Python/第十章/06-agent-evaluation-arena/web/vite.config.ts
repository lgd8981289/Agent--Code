import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // fileURLToPath 会解码中文和空格，不能把 URL 的 %20 当作真实目录名。
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  // 本项目只读取启动进程的环境变量，不自动探测或加载任何环境文件。
  envDir: false,
  server: {
    host: '127.0.0.1', port: Number(process.env.ARENA_WEB_PORT || 5188), strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 4318}` },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
})

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // 与 Python 后端一致，只从进程环境取配置，不自动读取环境文件。
  envDir: false,
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT || 5190),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PORT || 4320}`,
        timeout: 300000,
        ws: true,
      },
    },
  },
  build: { outDir: "dist" },
});

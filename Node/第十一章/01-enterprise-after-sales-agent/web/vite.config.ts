import { defineConfig } from "vite";
import "dotenv/config";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
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

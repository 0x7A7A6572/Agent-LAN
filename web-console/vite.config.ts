import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import tailwindcss from '@tailwindcss/vite'

// hub 地址可用 MAC_HUB 覆盖，缺省 9600
const hub = process.env.MAC_HUB ?? 'http://localhost:9600'

export default defineConfig({
  plugins: [vue(), vueDevTools(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 控制台资源与 A2A JSON-RPC 都来自 hub，dev/preview 全量代理
    proxy: {
      '/console': hub,
      '/agent': hub,
      '/files': hub,
      '/worker.sh': hub,
      '/probe.sh': hub,
      '/mcp': hub,
    },
  },
})

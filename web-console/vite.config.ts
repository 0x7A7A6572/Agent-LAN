import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueDevTools(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 控制台资源与 A2A JSON-RPC 都来自 hub，dev 时全量代理
    proxy: {
      '/console': 'http://localhost:9600',
      '/agent': 'http://localhost:9600',
      '/files': 'http://localhost:9600',
      '/worker.sh': 'http://localhost:9600',
      '/probe.sh': 'http://localhost:9600',
    },
  },
})

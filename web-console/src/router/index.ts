import { createRouter, createWebHashHistory } from 'vue-router'
import ConsoleHome from '@/views/ConsoleHome.vue'

// hash 模式：控制台由静态伺服分发，无 history 回退配置
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', component: ConsoleHome }],
})

import { defineStore } from 'pinia'
import { ref } from 'vue'

// 控制台壳层状态：面板折叠与日志显隐
export const useAppStore = defineStore('app', () => {
  const consoleExpanded = ref(false)
  const showLogs = ref(true)

  function toggleConsole(v?: boolean) {
    consoleExpanded.value = v ?? !consoleExpanded.value
  }
  function toggleLogs(v?: boolean) {
    showLogs.value = v ?? !showLogs.value
  }

  return { consoleExpanded, showLogs, toggleConsole, toggleLogs }
})

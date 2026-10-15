import { watch } from 'vue'

// 日志容器滚动到底：内容变化后自动跟随
export function useAutoLog(elRef: () => HTMLElement | null, source: () => unknown) {
  watch(source, () => {
    const el = elRef()
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  })
}

import type { Component } from 'vue'

/** 悬浮 tab 的一项：图标 + 标签 + 可选角标/警示 */
export interface FloatingTab {
  key: string
  label: string
  icon: Component
  /** 右上角数字角标；0 或省略不显示 */
  badge?: number
  /** 警示态：有等待人工的事时染成琥珀色 */
  alert?: boolean
}

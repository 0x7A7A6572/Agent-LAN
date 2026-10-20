# web-console

Agent-LAN 的网页控制台。Vue 3 + TypeScript + Tailwind CSS 4 + shadcn-vue，
3D 拓扑用 Three.js（按需动态加载，不切到该视图就不下载引擎）。

## 开发

```bash
pnpm install
pnpm dev        # Vite 开发服务器，接口默认指向同源的 /console/*
pnpm build      # 类型检查 + 构建到 dist/
```

## 构建产物去向

hub 直接托管构建产物：`packages/server` 的 build 脚本会把本目录 `dist/`
拷到 `packages/server/dist/web`，由 hub 在 `/console` 下提供静态资源。
所以**改了控制台要先 `pnpm build`，再构建 server**，否则页面还是旧的。

根目录的 `pnpm build` 已经按这个顺序串好了。

## 目录

| 路径 | 说明 |
|---|---|
| `src/views/ConsoleHome.vue` | 主页：节点卡 / 工单 / 日志 / 设置 四个视图 |
| `src/components/console/` | 业务组件；`topology3d.ts` 是 Three.js 场景本体 |
| `src/components/ui/` | shadcn-vue 组件，按需增删 |
| `src/api/console.ts` | 控制台 HTTP 接口封装 |
| `src/stores/console.ts` | Pinia store：SSE 名册、工单、PM 状态 |
| `public/cc0/night.bin.exr` | 3D 场景的 HDRI 环境贴图（夜间环境，CC0） |

## 3D 场景约定

- 先建 HDRI 环境再建材质，否则玻璃/金属没有反射内容，会显廉价
- 状态色只走发光，不要给实体整体染色
- 平台/底座用深灰哑光，发光只留给节点实体
- 挂载后才创建 WebGL 上下文，卸载必须 dispose，否则切视图会泄漏

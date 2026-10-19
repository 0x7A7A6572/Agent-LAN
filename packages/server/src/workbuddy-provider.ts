// 本地 WorkBuddy 模型接入：复用 dsh-workbuddy-connect 打开本机凭据并起 loopback shim
// 关键约束：插件路径与 Electron 二进制都要探测，任一缺失必须优雅降级而不是拖垮 hub

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 插件在 DSH profile 下的常见安装位置 */
const PROFILE_ROOTS = [
  path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules"),
  path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules"),
  path.join(os.homedir(), ".dsh", "profiles", "acp", "node_modules"),
];

/** WorkBuddy 桌面版可执行文件候选；插件需要它来解本机加密凭据 */
const ELECTRON_CANDIDATES = [
  path.join(os.homedir(), "AppData", "Local", "Programs", "WorkBuddy", "WorkBuddy.exe"),
  path.join(os.homedir(), "AppData", "Local", "Programs", "CodeBuddy", "CodeBuddy.exe"),
  "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
  "/Applications/CodeBuddy.app/Contents/MacOS/CodeBuddy",
];

export interface WorkbuddyProvider {
  /** OpenAI 兼容端点，带 /v1 后缀 */
  baseUrl: string;
  /** shim 的随机 bearer，仅本进程内有效 */
  token: string;
  /** 可用模型 id 列表 */
  models: string[];
  close(): Promise<void>;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  pluginPath?: string;
  electronPath?: string;
}

/** 找插件主模块；找不到返回 null */
export function findPlugin(): string | null {
  for (const root of PROFILE_ROOTS) {
    const p = path.join(root, "dsh-workbuddy-connect", "lib", "index.js");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 找 WorkBuddy 二进制；插件靠它解 at-rest 凭据 */
export function findElectron(): string | null {
  for (const p of ELECTRON_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 不启动服务的前置检查，供设置页显示「为什么不可用」 */
export function probeEnvironment(): ProbeResult {
  const pluginPath = findPlugin();
  if (!pluginPath) {
    return { ok: false, reason: "未找到 dsh-workbuddy-connect 插件（需在 DSH profile 里安装）" };
  }
  const electronPath = findElectron();
  if (!electronPath) {
    return { ok: false, reason: "未找到 WorkBuddy 桌面版（用来解本机登录凭据）", pluginPath };
  }
  return { ok: true, pluginPath, electronPath };
}

/**
 * 启动本地 shim。插件在 hub 进程里跑，凭据只在内存中流转。
 * 调用方负责 close()，进程退出时会自动回收 loopback 端口。
 */
export async function startWorkbuddy(): Promise<{ provider: WorkbuddyProvider } | { error: string }> {
  const env = probeEnvironment();
  if (!env.ok) return { error: env.reason ?? "环境不可用" };

  // 插件用这个环境变量定位 Electron 二进制
  process.env.WORKBUDDY_ELECTRON_BIN = env.electronPath!;

  try {
    const mod = await import(pathToFileURL(env.pluginPath!).href) as any;
    const variant = mod.CN_VARIANT;
    if (!variant) return { error: "插件缺少 CN_VARIANT，版本可能不兼容" };

    const client = new mod.WorkBuddyUpstreamClient();
    const store = new mod.WorkBuddyCredentialStore({
      variant,
      refresh: (credential: unknown) => client.refreshToken(credential),
    });

    // 读一次凭据：未登录时这里就会失败，比启动 shim 后再失败更早暴露
    try {
      await store.resolve();
    } catch (err: any) {
      return { error: "WorkBuddy 未登录或凭据无法解密：" + String(err?.message ?? err).slice(0, 200) };
    }

    const catalog = new mod.WorkBuddyCatalog(mod.FALLBACK_WORKBUDDY_MODELS ?? []);
    const shim = mod.createWorkBuddyShim({
      store,
      client,
      catalog,
      logger: { warn() {}, error() {}, info() {} },
    });

    try {
      await shim.ready;
    } catch (err: any) {
      return { error: "本地 shim 启动失败：" + String(err?.message ?? err).slice(0, 200) };
    }

    return {
      provider: {
        baseUrl: shim.baseUrl() + "/v1",
        token: shim.token(),
        models: catalog.current().map((m: any) => m.id),
        close: () => shim.close(),
      },
    };
  } catch (err: any) {
    return { error: "加载插件失败：" + String(err?.message ?? err).slice(0, 300) };
  }
}

/**
 * shim 只吐 SSE 流，而 PM 决策需要一次性拿到完整回复。
 * 这里把流拼回完整文本，兼容 data: 行与 [DONE] 结束标记。
 */
export async function readSseCompletion(res: Response, timeoutMs: number): Promise<string | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const reader = res.body?.getReader();
    if (!reader) return { error: "响应没有 body" };
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk?.choices?.[0]?.delta;
          if (typeof delta?.content === "string") text += delta.content;
        } catch { /* 心跳行与半截 JSON 直接跳过 */ }
      }
    }
    return text;
  } catch (err: any) {
    if (err?.name === "AbortError") return { error: "读取流超时" };
    return { error: "读取流失败: " + String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

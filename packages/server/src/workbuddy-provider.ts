// 本地 WorkBuddy 直连：读桌面版登录态、解 at-rest 凭据、直连上游
// 关键约束：凭据字段自 5.6 起加密，必须用 WorkBuddy 自己的 Electron 解
//
// 凭据解密的算法来自 dsh-workbuddy-connect（MIT, Copyright (c) 2026 Corrine Hu）
// 逆向 WorkBuddy 5.6.2 所得，此处按其许可条件移植。WorkBuddy 若改格式需同步更新。

import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── 端点与协议常量 ──────────────────────────────────────────────────
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** 与桌面版一致的客户端标识 */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const HELPER_TIMEOUT_MS = 20000;
const JSON_TIMEOUT_MS = 30000;

/** Electron 执行辅助脚本的入参：解出加密密钥载荷 */
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
const HELPER_FLAG = "-e";

// ── 凭据文件位置 ────────────────────────────────────────────────────
const AUTH_FILES = [
  path.join(os.homedir(), "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
  path.join(os.homedir(), "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
  path.join(os.homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
  path.join(os.homedir(), ".config", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
];

/** WorkBuddy 桌面版可执行文件：解凭据必须用它 */
const ELECTRON_FILES = [
  path.join(os.homedir(), "AppData", "Local", "Programs", "WorkBuddy", "WorkBuddy.exe"),
  path.join(os.homedir(), "AppData", "Local", "Programs", "CodeBuddy", "CodeBuddy.exe"),
  "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
  "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron",
];

/** 内置兜底模型表：拿不到实时目录时用它，避免下拉为空 */
export const FALLBACK_MODELS = [
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "hy4-preview",
  "hy3",
  "hy3-x",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k3-2",
  "minimax-m3",
  "step-5-preview",
];

export interface WorkbuddyCredential {
  accessToken: string;
  refreshToken: string;
  domain: string;
  uid: string;
  enterpriseId?: string;
  expiresAtMs: number;
}

export interface WorkbuddyProvider {
  models: string[];
  chat(body: unknown, timeoutMs: number): Promise<{ text: string } | { error: string }>;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  authFile?: string;
  electronPath?: string;
}

// ── 环境探测 ────────────────────────────────────────────────────────
function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

export function probeEnvironment(): ProbeResult {
  const authFile = firstExisting(AUTH_FILES);
  if (!authFile) {
    return { ok: false, reason: "未找到 WorkBuddy 登录凭据（请先在 WorkBuddy 桌面版登录）" };
  }
  const electronPath = firstExisting(ELECTRON_FILES);
  if (!electronPath) {
    return { ok: false, reason: "未找到 WorkBuddy 桌面版（解加密凭据需要它）", authFile };
  }
  return { ok: true, authFile, electronPath };
}

// ── 枚举字段解密（移植自 dsh-workbuddy-connect/desktop-credential-protection）──
interface Envelope {
  suite: number;
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** base64 解码并按需校验长度；非规范 base64 一律拒绝 */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
  if (decoded.length === 0) return undefined;
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined;
  return length === undefined || decoded.length === length ? decoded : undefined;
}

/** 5.6 起的字段包装：{$wbEncrypted:1, envelope:<base64(JSON)>} */
function parseWrappedField(value: unknown): Envelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const wrapped = value as Record<string, unknown>;
  if (wrapped["$wbEncrypted"] !== 1 || typeof wrapped["envelope"] !== "string") return undefined;
  let inner: unknown;
  try {
    inner = JSON.parse(Buffer.from(wrapped["envelope"], "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;
  const parts = inner as Record<string, unknown>;
  const nonce = parseBase64(parts["nonce"], 12);
  const authTag = parseBase64(parts["authTag"], 16);
  const ciphertext = parseBase64(parts["ciphertext"]);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  if (parts["suite"] !== 1) return undefined;
  if (typeof parts["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(parts["keyId"])) return undefined;
  return { suite: 1, keyId: parts["keyId"], nonce, authTag, ciphertext };
}

/**
 * WorkBuddy 自己的认证上下文 AAD，按其 app bundle 的
 * buildAuthenticatedContextAad 逐字节复刻（凭证字段固定 suite 1 / WBEV1 帧）
 */
function buildAad(keyId: string, suite: number): Buffer {
  const prefix = Buffer.from("WB-AAD\0", "ascii");
  const lengthPrefixed = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 用密钥开一个信封；失败返回 undefined（格式不符或密钥不对） */
function openAuthField(key: Buffer, envelope: Envelope): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** 校验 Electron helper 的输出：version 1 + 规范 base64 的 32 字节非全零密钥 */
function parseAtRestPayload(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const payload = parsed as Record<string, unknown>;
  if (payload["version"] !== 1) return undefined;
  const secret = payload["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") return undefined;
  const decoded = Buffer.from(secret, "base64");
  if (decoded.length !== 32) return undefined;
  if (decoded.toString("base64") !== secret) return undefined;
  if (decoded.every(byte => byte === 0)) return undefined;
  return secret;
}

/** 跑一次 WorkBuddy 的 Electron 取加密密钥载荷 */
function readAtRestSecret(electronPath: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      electronPath,
      [HELPER_FLAG, HELPER_SCRIPT],
      {
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const out = stdout.trim();
        if (!out) return resolve(undefined);
        resolve(parseAtRestPayload(out));
      },
    );
  });
}

// ── 凭据读取 ────────────────────────────────────────────────────────
function expiryToMs(value: number): number {
  if (value <= 0) return 0;
  // 秒与毫秒两种口径：超过这个量级视为已是毫秒
  return value > 0xe8d4a51000 ? value : value * 1000;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 解析明文凭据文档，兼容 {auth, account} 嵌套与扁平两种形态 */
export function parseCredential(text: string): WorkbuddyCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const doc = parsed as Record<string, any>;
  const auth = typeof doc["auth"] === "object" && doc["auth"] !== null ? doc["auth"] : doc;
  const identity = typeof doc["account"] === "object" && doc["account"] !== null ? doc["account"] : doc;
  const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
  if (!accessToken) return undefined;
  return {
    accessToken,
    refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
    domain: optionalString(auth["domain"]) ?? "",
    uid: optionalString(identity["uid"]) ?? "",
    enterpriseId: optionalString(identity["enterpriseId"]),
    expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
  };
}

/**
 * 读凭据：文档可能是明文，也可能是加密字段。
 * 加密时用 Electron 解出密钥再逐字段解开，还原成明文再走常规解析。
 */
export async function loadCredential(): Promise<{ credential: WorkbuddyCredential; authFile: string } | { error: string }> {
  const env = probeEnvironment();
  if (!env.ok) return { error: env.reason ?? "环境不可用" };

  let text: string;
  try {
    text = fs.readFileSync(env.authFile!, "utf8");
  } catch (err: any) {
    return { error: "读取凭据文件失败：" + String(err?.message ?? err) };
  }
  if (!text.trim()) return { error: "凭据文件为空，请重新登录 WorkBuddy" };

  let doc: Record<string, any>;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: "凭据文件不是合法 JSON" };
  }
  const auth = typeof doc["auth"] === "object" && doc["auth"] !== null ? doc["auth"] : doc;

  // 找出被加密的字段
  const encrypted: { field: string; env: Envelope }[] = [];
  for (const field of ["accessToken", "refreshToken"]) {
    const value = auth[field];
    if (value === undefined || typeof value === "string") continue;
    const parsed = parseWrappedField(value);
    if (!parsed) return { error: "凭据字段 " + field + " 的加密格式无法识别（WorkBuddy 可能改版）" };
    encrypted.push({ field, env: parsed });
  }

  if (encrypted.length) {
    const secret = await readAtRestSecret(env.electronPath!);
    if (!secret) {
      return { error: "无法通过 WorkBuddy 桌面板解开加密凭据（请确认桌面版已安装且当前登录）" };
    }
    const key = createHash("sha256").update(secret, "utf8").digest();
    for (const item of encrypted) {
      const value = openAuthField(key, item.env);
      if (value === undefined) {
        return { error: "凭据字段 " + item.field + " 解密失败（格式或密钥不匹配）" };
      }
      auth[item.field] = value;
    }
    text = JSON.stringify(doc);
  }

  const credential = parseCredential(text);
  if (!credential) return { error: "凭据里没有 accessToken，请在 WorkBuddy 中重新登录" };
  return { credential, authFile: env.authFile! };
}

// ── 上游调用 ────────────────────────────────────────────────────────
function regionOf(domain: string): "cn" | "global" {
  const lowered = domain.trim().toLowerCase();
  return lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai") ? "global" : "cn";
}

function chatBase(domain: string): string {
  return regionOf(domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}

function originReferer(domain: string): string {
  return regionOf(domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}

/** 上游要求的会话三元组，缺任一项会被拒 */
function conversationHeaders(): Record<string, string> {
  return {
    "X-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
  };
}

function chatHeaders(c: WorkbuddyCredential): Record<string, string> {
  const origin = originReferer(c.domain);
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: origin + "/",
    "User-Agent": CLIENT_UA,
    "Content-Type": "application/json",
    ...(c.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": c.uid }),
    ...(c.enterpriseId === undefined || c.enterpriseId === ""
      ? { "X-No-Enterprise-Id": "1" }
      : { "X-Enterprise-Id": c.enterpriseId }),
    ...(c.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": c.domain }),
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": "2.63.2",
    "X-Product": "SaaS",
    "Authorization": "Bearer " + c.accessToken,
    ...conversationHeaders(),
  };
}

/** 上游只接受 SSE，这里把流拼回完整文本 */
async function readSse(body: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const reader = body.getReader();
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
        } catch { /* 心跳与半截 JSON 跳过 */ }
      }
    }
    return text;
  } catch (err: any) {
    if (err?.name === "AbortError") return { error: "读取上游流超时" };
    return { error: "读取上游流失败：" + String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 拉一次模型目录；失败回落到内置表 */
async function fetchModels(c: WorkbuddyCredential): Promise<string[]> {
  try {
    const res = await fetch(chatBase(c.domain) + "/v3/config", {
      method: "GET",
      headers: { ...chatHeaders(c), Accept: "application/json" },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    if (!res.ok) return FALLBACK_MODELS;
    const data = await res.json() as any;
    // 目录结构可能随版本变化，宽泛地收集形如模型的 id
    const found = new Set<string>();
    const walk = (node: unknown, depth = 0) => {
      if (depth > 6 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
      const obj = node as Record<string, unknown>;
      const id = obj["id"] ?? obj["model"];
      if (typeof id === "string" && /^[a-z0-9][a-z0-9.\-]{2,}$/i.test(id)) found.add(id);
      for (const v of Object.values(obj)) walk(v, depth + 1);
    };
    walk(data);
    return found.size ? [...found] : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

/**
 * 建立 provider：读一次凭据、拉一次模型表。
 * 每次 chat 都重新解析凭据，token 刷新后无需重启 hub。
 */
export async function createWorkbuddyProvider(): Promise<{ provider: WorkbuddyProvider } | { error: string }> {
  const first = await loadCredential();
  if ("error" in first) return { error: first.error };
  const models = await fetchModels(first.credential);

  return {
    provider: {
      models,
      async chat(body, timeoutMs) {
        // 现读凭据：过期或换号后不需要重启
        const loaded = await loadCredential();
        if ("error" in loaded) return { error: loaded.error };
        const c = loaded.credential;
        try {
          // 上游只接受流式：不带 stream 会被 11101 拒绝
          const payload = { ...(body as Record<string, unknown>), stream: true };
          const res = await fetch(chatBase(c.domain) + "/v2/chat/completions", {
            method: "POST",
            headers: chatHeaders(c),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            const detail = (await res.text().catch(() => "")).slice(0, 300);
            return { error: "上游 HTTP " + res.status + (detail ? "：" + detail : "") };
          }
          if (!res.body) return { error: "上游没有返回流" };
          const text = await readSse(res.body, timeoutMs);
          return typeof text === "string" ? { text } : text;
        } catch (err: any) {
          if (err?.name === "AbortError") return { error: "上游请求超时（" + timeoutMs + "ms）" };
          return { error: "上游请求失败：" + String(err?.message ?? err) };
        }
      },
    },
  };
}

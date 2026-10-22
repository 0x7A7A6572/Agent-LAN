#!/usr/bin/env node
/**
 * Agent-LAN 提问 hook —— 把 agent 的 AskUserQuestion 送到 hub，让控制台能看见并作答。
 *
 * 挂法（CLI 的 hooks，PreToolUse + PostToolUse 同一 matcher）：
 *   PreToolUse  matcher=^AskUserQuestion$  -> node hook-ask.mjs ask
 *   PostToolUse matcher=^AskUserQuestion$  -> node hook-ask.mjs done
 *
 * 用法：
 *   node hook-ask.mjs install    把本脚本装进 ~/.mac-worker/<agent>/ 并合并进 settings.json
 *   node hook-ask.mjs print      只打印要合并的 hooks 片段（手工粘贴用）
 *   node hook-ask.mjs ask        hook 入口：读 stdin，上报提问
 *   node hook-ask.mjs done       hook 入口：读 stdin，清除该提问
 *
 * 铁律：hook 绝不能拖住或拦住工具调用。
 *   - 3s 硬超时，hub 不可达直接退出 0
 *   - 不往 stdout 写任何决策（PreToolUse 输出 allow 会跳过权限确认，不能用）
 *   - 任何异常都吞掉，只在自身日志里留一行
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODE = (process.argv[2] ?? "ask").toLowerCase();
const MARKER = "hook-ask.mjs";
const TIMEOUT_MS = 3000;
/** 节点存活窗口：worker 心跳 10s，留 120s 余量；超过就当没有活着的节点 */
const LIVE_MS = 120_000;
/**
 * 抢占式等代答：提问前挂在这里等这么久，控制台答了就直接把答案交给模型。
 * 0 = 关掉抢占（只上报、不等待）。上限 10s——再长会顶到 CLI 的 hook 超时判拦截。
 */
const ASK_WAIT_MS = Math.max(0, Math.min(Number(process.env.MAC_ASK_WAIT_MS ?? 5000) || 0, 10_000));

const ROOT = path.join(os.homedir(), ".mac-worker");

function logLine(msg) {
  try {
    const dir = path.join(os.homedir(), ".mac-worker", "hook-ask");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "hook-ask.log");
    const stamp = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(file, `[${stamp}] ${MODE} ${msg}\n`);
    // 超过 200KB 截半，避免无限长
    const st = fs.statSync(file);
    if (st.size > 200 * 1024) {
      const keep = fs.readFileSync(file, "utf8").split("\n").slice(-500).join("\n");
      fs.writeFileSync(file, keep);
    }
  } catch { /* 日志失败不影响主流程 */ }
}

// ─── 节点身份：node.json 是唯一事实来源（worker.sh 每轮都写 state） ───
function listNodes() {
  const out = [];
  let agents = [];
  try { agents = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return out; }
  for (const agent of agents) {
    const file = path.join(ROOT, agent, "node.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || !raw.name || !raw.server) continue;
      const state = raw.state ?? {};
      const at = Date.parse(state.updatedAt ?? "") || 0;
      out.push({
        agent,
        dir: path.join(ROOT, agent),
        name: String(raw.name),
        server: String(raw.server),
        online: state.online !== false && !!state.updatedAt,
        at,
        working: state.working ?? null,
        role: raw.role ?? ""
      });
    } catch { /* 半个文件或坏 JSON：跳过 */ }
  }
  return out;
}

/** 挑出这次提问该归给谁：env 指定 > 唯一活着且手上有活的节点 > 唯一活着的节点 */
function resolveNode() {
  const nodes = listNodes();
  if (!nodes.length) return { error: "本机没有 node.json（先跑 probe.sh --install）" };
  const envName = process.env.MAC_NODE || process.env.MAC_HOOK_NODE || "";
  if (envName) {
    const hit = nodes.find(n => n.name === envName);
    return hit ? { node: hit } : { error: "MAC_NODE=" + envName + " 找不到对应 node.json" };
  }
  const live = nodes.filter(n => n.online && Date.now() - n.at < LIVE_MS);
  if (!live.length) return { error: "没有活着的节点（worker 未运行或已超 120s 无心跳）" };
  const busy = live.filter(n => n.working);
  const pool = busy.length ? busy : live;
  pool.sort((a, b) => b.at - a.at);
  return { node: pool[0] };
}

// ─── hook stdin ───────────────────────────────────────────────────────
function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    const done = () => resolve(buf);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { buf += c; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    // 兜底：某些宿主不给 EOF
    setTimeout(done, 800).unref?.();
  });
}

async function post(server, payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("http://" + server + "/worker/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 长等代答：hub 那边挂起直到有人答或超时 */
async function waitAnswer(server, name, id, waitMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), waitMs + 4000);
  try {
    const qs = new URLSearchParams({ name, waitMs: String(waitMs) });
    if (id) qs.set("id", id);
    const res = await fetch("http://" + server + "/worker/ask/answer?" + qs.toString(), { signal: ctl.signal });
    const data = await res.json();
    return Array.isArray(data?.answers) ? data.answers : [];
  } catch { return []; } finally { clearTimeout(timer); }
}

/**
 * 抢占式放行：deny + reason 是唯一能把「答案」塞回模型的钩子出口。
 * AskUserQuestion 被 deny 后模型会拿到 reason 继续往下走，本地框不再弹出。
 */
function denyWithAnswer(answer) {
  const reason = String(answer?.text ?? "").trim() ||
    "【控制台答复】用户已在 Agent-LAN 控制台作答，请按答复继续。";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason + "\n（这是人在控制台代答的结果，不要再重复调用 AskUserQuestion 问同一件事）"
    }
  }));
}

/** 摘要：把 AskUserQuestion 的 questions 压成一行标题，控制台 banner 直接显示 */
function titleOf(input, node) {
  const cwd = path.basename(String(input?.cwd ?? process.cwd())) || "会话";
  const work = node?.working?.prompt ? String(node.working.prompt).replace(/\s+/g, " ").slice(0, 40) : "";
  return work ? cwd + " · " + work : cwd;
}

function idFile(node, sessionId) {
  const safe = String(sessionId ?? "nosession").replace(/[^\w.-]/g, "_").slice(0, 48);
  return path.join(node.dir, ".hook-ask." + safe + ".id");
}

async function runAsk() {
  const raw = await readStdin();
  let hook = {};
  try { hook = JSON.parse(raw || "{}"); } catch { logLine("stdin 不是 JSON，忽略"); return; }
  const { node, error } = resolveNode();
  if (error) { logLine("跳过：" + error); return; }
  const questions = hook?.tool_input?.questions;
  const payload = {
    name: node.name,
    kind: "ask",
    title: titleOf({ cwd: hook.cwd }, node),
    taskId: node.working?.id ?? node.working?.taskId ?? undefined,
    sessionId: hook.session_id ?? undefined,
    questions: Array.isArray(questions) ? questions : []
  };
  if (!payload.questions.length && !payload.title) { logLine("没有问题内容，忽略"); return; }
  const r = await post(node.server, payload);
  if (!r.ok) { logLine(`${node.name} 上报失败 ${r.status}：${r.text.slice(0, 120)}（不等待，走本地框）`); return; }
  let res = {};
  try { res = JSON.parse(r.text); } catch { /* 老 hub 只回 ok */ }
  logLine(`${node.name} <- ${payload.questions.length} 问 -> ${r.status} ok${res.answered ? " (已答)" : ""}`);
  // 这一问之前已经被答过（模型重试同一提问）：直接把答案还回去，断掉重复问
  if (res.answered && res.answer) { denyWithAnswer(res.answer); return; }
  try {
    const id = res?.id;
    if (id) fs.writeFileSync(idFile(node, hook.session_id), id);
    if (!ASK_WAIT_MS) return;
    // 抢占式：等控制台代答；等到就 deny 放行，等不到就静默退出让本地框正常弹
    const answers = await waitAnswer(node.server, node.name, id, ASK_WAIT_MS);
    if (answers.length) {
      logLine(`${node.name} 抢占成功，代答放行（${ASK_WAIT_MS}ms 窗口）`);
      denyWithAnswer(answers[0]);
    } else {
      logLine(`${node.name} ${ASK_WAIT_MS}ms 内无人代答，交给本地框`);
    }
  } catch { /* id 落盘失败只影响 done 的精确清除 */ }
}

async function runDone() {
  const raw = await readStdin();
  let hook = {};
  try { hook = JSON.parse(raw || "{}"); } catch { /* 空 stdin 也照清 */ }
  const { node, error } = resolveNode();
  if (error) { logLine("跳过：" + error); return; }
  let expectId = "";
  const file = idFile(node, hook.session_id);
  try { expectId = fs.readFileSync(file, "utf8").trim(); fs.unlinkSync(file); } catch { /* 没答过就没 id */ }
  const r = await post(node.server, { name: node.name, clear: true, expectId: expectId || undefined });
  logLine(`${node.name} done -> ${r.status} ${r.text.slice(0, 120)}`);
}

// ─── 安装：合并进 CLI 的 settings.json（幂等，靠 command 里的标记识别旧条目） ───
function configDir() {
  if (process.env.CODEBUDDY_CONFIG_DIR) return process.env.CODEBUDDY_CONFIG_DIR;
  const wb = path.join(os.homedir(), ".workbuddy");
  const cb = path.join(os.homedir(), ".codebuddy");
  if (fs.existsSync(wb)) return wb;
  if (fs.existsSync(cb)) return cb;
  return wb;
}

function hookEntry(scriptPath, mode) {
  const cmd = 'node "' + scriptPath.replace(/\\/g, "/") + '" ' + mode;
  return { matcher: "^AskUserQuestion$", hooks: [{ type: "command", command: cmd, timeout: 20 }] };
}

function mergeHooks(settings, scriptPath) {
  settings.hooks = settings.hooks ?? {};
  for (const ev of ["PreToolUse", "PostToolUse"]) {
    const kept = (settings.hooks[ev] ?? []).filter(
      e => !(e?.hooks ?? []).some(h => String(h?.command ?? "").includes(MARKER))
    );
    kept.push(hookEntry(scriptPath, ev === "PreToolUse" ? "ask" : "done"));
    settings.hooks[ev] = kept;
  }
  return settings;
}

function runInstall() {
  const { node, error } = resolveNode();
  const destDir = node?.dir ?? path.join(ROOT, process.env.AGENT || "workbuddy");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "hook-ask.mjs");
  fs.copyFileSync(process.argv[1], dest);
  const file = path.join(configDir(), "settings.json");
  // 解析失败必须中止：settings.json 是用户全部配置，覆盖成 {} 是灾难
  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    try {
      settings = JSON.parse(raw || "{}");
    } catch (err) {
      console.error("[x] " + file + " 不是合法 JSON，已中止（未做任何修改）：" + String(err?.message ?? err));
      process.exit(1);
    }
    if (!raw.trim()) settings = {};
  }
  mergeHooks(settings, dest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak-hook-ask");
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log("[✓] hook 脚本 -> " + dest);
  console.log("[✓] hooks 已合并 -> " + file + "（原文件备份 " + path.basename(file) + ".bak-hook-ask）");
  if (error) console.log("[!] 未找到活着的节点（" + error + "），装好后 worker 起来即可生效");
  console.log("    重启会话后生效：AskUserQuestion 会自动上报到 hub 控制台");
}

function runPrint() {
  const dest = path.join(ROOT, process.env.AGENT || "workbuddy", "hook-ask.mjs");
  console.log(JSON.stringify({ hooks: mergeHooks({}, dest).hooks }, null, 2));
}

try {
  if (MODE === "install") runInstall();
  else if (MODE === "print") runPrint();
  else if (MODE === "done") await runDone();
  else await runAsk();
} catch (err) {
  logLine("异常：" + String(err?.message ?? err));
}
// 永远 0 退出：hook 出错不能拦工具
process.exit(0);

#!/usr/bin/env node
/**
 * Agent-LAN 提问 hook —— 把 agent 的 AskUserQuestion 送到 hub，让控制台能看见并作答。
 *
 * 挂法（CLI 的 hooks）：
 *   Notification  matcher=permission_prompt  -> node hook-ask.mjs notify   ← 卡片弹出时（点击前）
 *   PreToolUse    matcher=^AskUserQuestion$   -> node hook-ask.mjs ask     ← 用户点完之后
 *   PostToolUse   matcher=^AskUserQuestion$   -> node hook-ask.mjs done
 *
 * 为什么需要两个事件（实测结论，别删）
 *   PreToolUse 在「用户点完卡片」之后才触发（实测相差 2 分 31 秒），此时 tool_input 里已是
 *   用户的选择，控制台再答没有意义。真正「卡片弹出」的时刻只有 Notification 事件能抓到
 *   （早于点击几十秒），但它的输出被 CLI 直接丢弃（executeNotificationHooks 不接返回值），
 *   没有回填答案的通道。所以：Notification 负责「点击前上报」，PreToolUse 负责「事后回填」。
 *
 * 用法：
 *   node hook-ask.mjs install    把本脚本装进 ~/.mac-worker/<agent>/ 并合并进 settings.json
 *   node hook-ask.mjs print      只打印要合并的 hooks 片段（手工粘贴用）
 *   node hook-ask.mjs notify     hook 入口：卡片弹出，从 transcript 读出提问并上报（不等答复）
 *   node hook-ask.mjs ask        hook 入口：读 stdin，上报提问（用户已点完，仅事后续期）
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
 * ask（PreToolUse）在用户点完卡片之后才触发，此时再「等控制台答复」没有意义：
 * 人要么在点击前已经在控制台答过（那就直接 deny 回填），要么就是在卡片里答的。
 * 所以默认不等，只查一次「控制台有没有替我答过」。
 * 需要真抢占的调用方（MCP 的 mac_ask_console）自己传更长的等待。
 * 取值优先级：env MAC_ASK_WAIT_MS > node.json 的 askWaitMs > 0。
 */
const DEFAULT_WAIT_MS = 0;
const MAX_WAIT_MS = 15_000;
function pickWaitMs(node) {
  const envRaw = process.env.MAC_ASK_WAIT_MS;
  const env = envRaw === undefined || envRaw === "" ? NaN : Number(envRaw);
  const cfg = Number(node?.askWaitMs);
  const raw = Number.isFinite(env) ? env : (Number.isFinite(cfg) && cfg > 0 ? cfg : DEFAULT_WAIT_MS);
  return Math.max(0, Math.min(raw || 0, MAX_WAIT_MS));
}

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
        role: raw.role ?? "",
        // 节点级等待窗口：忘带这个字段，pickWaitMs 就永远拿默认 5s（踩过）
        askWaitMs: raw.askWaitMs
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
  if (live.length) {
    const busy = live.filter(n => n.working);
    const pool = busy.length ? busy : live;
    pool.sort((a, b) => b.at - a.at);
    return { node: pool[0] };
  }
  // 心跳全过期：GUI 会话里 worker 常不常驻，拿它当否决条件会让 hook 永远静默跳过。
  // 本机只有一个 node.json 时归属没有歧义 → 直接用；多个才需要 MAC_NODE 指定。
  const withBeat = nodes.filter(n => n.at);
  if (withBeat.length === 1) {
    return { node: withBeat[0], stale: Math.round((Date.now() - withBeat[0].at) / 1000) };
  }
  if (withBeat.length > 1) {
    withBeat.sort((a, b) => b.at - a.at);
    return { node: withBeat[0], stale: Math.round((Date.now() - withBeat[0].at) / 1000), ambiguous: withBeat.length };
  }
  return { error: "没有可用的节点身份（node.json 里没有 state.updatedAt，先跑一次 worker.sh）" };
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

// ─── notify：卡片弹出的真实时刻（比 PreToolUse 早几十秒）─────────────────
/**
 * 从 transcript 尾部找出最后一次 AskUserQuestion 调用。
 * Notification 的 payload 只有一句 message，问题与选项只能这么拿。
 * 只读尾部 512KB：transcript 可能是几 MB，全量读会让 hook 超过 5s 超时。
 */
function readLastAsk(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const st = fs.statSync(transcriptPath);
    const size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{") || !line.includes("AskUserQuestion")) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== "function_call" || j.name !== "AskUserQuestion") continue;
      let args = j.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
      if (Array.isArray(args?.questions) && args.questions.length) return args.questions;
    }
  } catch { /* 读不到就当没有 */ }
  return null;
}

async function runNotify() {
  const raw = await readStdin();
  let hook = {};
  try { hook = JSON.parse(raw || "{}"); } catch { logLine("notify stdin 不是 JSON，忽略"); return; }
  const type = String(hook.notification_type ?? "");
  const msg = String(hook.message ?? "");
  // 只接「等你操作某个工具」这一类；空闲提醒、完成提醒跟提问无关
  if (type !== "permission_prompt" && !/AskUserQuestion/i.test(msg)) return;
  const questions = readLastAsk(hook.transcript_path);
  if (!questions) { logLine("notify 收到通知，但 transcript 里没找到提问"); return; }
  const { node, error, stale } = resolveNode();
  if (error) { logLine("notify 跳过：" + error); return; }
  if (stale !== undefined) logLine(`notify 用过期心跳的节点 ${node.name}（${stale}s 前）`);
  const r = await post(node.server, {
    name: node.name,
    kind: "ask",
    title: titleOf({ cwd: hook.cwd }, node),
    taskId: node.working?.id ?? node.working?.taskId ?? undefined,
    sessionId: hook.session_id ?? undefined,
    questions
  });
  let res = {};
  try { res = JSON.parse(r.text); } catch { /* 老 hub 只回 ok */ }
  logLine(`notify ${node.name} <- ${questions.length} 问 -> ${r.status}${r.ok ? "" : " " + r.text.slice(0, 100)}`);
  // 记下 id：用户点完卡片后 done 靠它精确清除这一问
  if (r.ok && res.id) { try { fs.writeFileSync(idFile(node, hook.session_id), res.id); } catch { /* 落盘失败只影响精确清除 */ } }
  // 注意：Notification 的输出会被 CLI 丢弃，这里不要写任何决策
}

async function runAsk() {
  const raw = await readStdin();
  let hook = {};
  try { hook = JSON.parse(raw || "{}"); } catch { logLine("stdin 不是 JSON，忽略"); return; }
  const { node, error, stale, ambiguous } = resolveNode();
  if (error) { logLine("跳过：" + error); return; }
  if (stale !== undefined) {
    logLine(`用过期心跳的节点 ${node.name}（${stale}s 前${ambiguous ? "，本机 " + ambiguous + " 个候选取最新" : ""}）`);
  }
  // 提问文本必须和 notify 完全同源（都从 transcript 读），否则 hub 里的「同一问」
  // 判定会失配 —— 后果是 ask 重建题卡、把人在控制台已经给出的答复丢掉。
  const questions = readLastAsk(hook.transcript_path) ?? hook?.tool_input?.questions;
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
    const waitMs = pickWaitMs(node);
    if (!waitMs) { logLine(`${node.name} 抢占已关（waitMs=0），只上报不等`); return; }
    // 抢占式：等控制台代答；等到就 deny 放行，等不到就静默退出让本地框正常弹
    const answers = await waitAnswer(node.server, node.name, id, waitMs);
    if (answers.length) {
      logLine(`${node.name} 抢占成功，代答放行（${waitMs}ms 窗口）`);
      denyWithAnswer(answers[0]);
    } else {
      logLine(`${node.name} ${waitMs}ms 内无人代答，交给本地框`);
    }
  } catch { /* id 落盘失败只影响 done 的精确清除 */ }
}

async function runDone() {
  const raw = await readStdin();
  let hook = {};
  try { hook = JSON.parse(raw || "{}"); } catch { /* 空 stdin 也照清 */ }
  const { node, error, stale, ambiguous } = resolveNode();
  if (error) { logLine("跳过：" + error); return; }
  if (stale !== undefined) {
    logLine(`用过期心跳的节点 ${node.name}（${stale}s 前${ambiguous ? "，本机 " + ambiguous + " 个候选取最新" : ""}）`);
  }
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
  const drop = ev =>
    (settings.hooks[ev] ?? []).filter(
      e => !(e?.hooks ?? []).some(h => String(h?.command ?? "").includes(MARKER))
    );
  // Notification 是「卡片弹出」唯一抓得到的时机：它比 PreToolUse 早几十秒，
  // matcher 匹配 notification_type，提问这一类固定是 permission_prompt
  settings.hooks.Notification = drop("Notification");
  settings.hooks.Notification.push({
    matcher: "permission_prompt",
    hooks: [{ type: "command", command: 'node "' + scriptPath.replace(/\\/g, "/") + '" notify', timeout: 8 }]
  });
  for (const ev of ["PreToolUse", "PostToolUse"]) {
    const kept = drop(ev);
    kept.push(hookEntry(scriptPath, ev === "PreToolUse" ? "ask" : "done"));
    settings.hooks[ev] = kept;
  }
  return settings;
}

function runInstall() {
  // MAC_FORCE_AGENT 由 probe.sh 传：安装时节点还没起，不能靠「活着的节点」猜目录，
  // 更不能因为本机另有活着的 agent 就把 hook 装到别人目录里
  const forced = process.env.MAC_FORCE_AGENT || "";
  const { node, error } = forced ? { node: null, error: "" } : resolveNode();
  const destDir = forced
    ? path.join(ROOT, forced)
    : (node?.dir ?? path.join(ROOT, process.env.AGENT || "workbuddy"));
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
  else if (MODE === "notify") await runNotify();
  else if (MODE === "done") await runDone();
  else await runAsk();
} catch (err) {
  logLine("异常：" + String(err?.message ?? err));
}
// 永远 0 退出：hook 出错不能拦工具
process.exit(0);

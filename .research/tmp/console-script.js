
  const grid = document.getElementById("grid");
  const summary = document.getElementById("summary");
  const logbox = document.getElementById("logbox");
  let lastCount = -1;

  // keyed 增量渲染：卡片 DOM 与节点共存亡，输入框永不重建
  const cards = new Map(); // name -> {el, badge, meta, say, input, dot}

  function buildCard(p) {
    const div = document.createElement("div");
    div.className = "agent " + (p.online ? "online" : "offline");
    div.innerHTML =
      "<h2><span class='dot'></span>" + esc(p.card.name) +
      "<span class='badge'></span></h2>" +
      "<div class='meta'></div>" +
      "<div class='say'><input placeholder='留言插话…' data-to='" + esc(p.card.name) + "'><button data-to='" + esc(p.card.name) + "'>发送</button></div>";
    return {
      el: div,
      badge: div.querySelector(".badge"),
      meta: div.querySelector(".meta"),
      input: div.querySelector("input"),
      host: p.groupHost || p.card.host || p.card.url
    };
  }

  function render(presences) {
    const online = presences.filter(p => p.online);
    const g = (p) => p.groupHost || p.card.host || p.card.url;
    const hosts = new Set(presences.map(g));
    const onlineHosts = new Set(presences.filter(p => p.online).map(g));
    summary.textContent =
      online.length + " 在线 / " + presences.length + " 节点 · " +
      onlineHosts.size + "/" + hosts.size + " 台主机 · 每 10s 心跳";

    const seen = new Set();
    // 分组顺序：按 groupHost 排序，保证同组卡片相邻
    const sorted = [...presences].sort((a, b) => g(a).localeCompare(g(b)));
    for (const p of sorted) {
      seen.add(p.card.name);
      let c = cards.get(p.card.name);
      if (!c) { c = buildCard(p); cards.set(p.card.name, c); }
      // 原地更新变化的部分
      const cls = "agent " + (p.online ? "online" : "offline");
      if (c.el.className !== cls) c.el.className = cls;
      const badge = p.online ? "在线" : "离线";
      if (c.badge.textContent !== badge) c.badge.textContent = badge;
      const meta = esc(p.card.description || "") + " · 心跳 " + new Date(p.lastSeen).toLocaleTimeString("zh-CN", { hour12: false });
      if (c.meta.dataset.raw !== p.lastSeen + p.card.description) {
        c.meta.dataset.raw = p.lastSeen + p.card.description;
        c.meta.innerHTML = meta;
      }
      // 分组容器（懒创建）
      const host = g(p);
      let groupEl = document.getElementById("grp-" + CSS.escape(host)) || createGroup(host, p, anyOnOf(sorted, host));
      // 在线状态联动组样式
      const members = sorted.filter(x => g(x) === host);
      const anyOn = members.some(x => x.online);
      const wantCls = "group " + (anyOn ? "online" : "offline");
      if (groupEl.className !== wantCls) groupEl.className = wantCls;
      const hbadge = groupEl.querySelector(".hbadge");
      const hb = members.filter(x => x.online).length + "/" + members.length + " 在线";
      if (hbadge.textContent !== hb) hbadge.textContent = hb;
      // 挪位（appendChild 对已存在节点=移动，不重建）
      if (c.el.parentElement !== groupEl || groupEl.lastElementChild !== c.el) groupEl.appendChild(c.el);
      if (groupEl.parentElement !== grid) grid.appendChild(groupEl);
    }
    // 移除消失的节点
    for (const [name, c] of cards) {
      if (!seen.has(name)) { c.el.remove(); cards.delete(name); }
    }
    // 移除空组
    grid.querySelectorAll(".group").forEach(gr => {
      if (!gr.querySelector(".agent")) gr.remove();
    });
  }

  const groupEls = new Map(); // host -> el
  function anyOnOf(sorted, host) {
    return sorted.some(x => (x.groupHost || x.card.host || x.card.url) === host && x.online);
  }
  function createGroup(host, p, anyOn) {
    const key = "grp-" + CSS.escape(host);
    let el = document.getElementById(key);
    if (el) return el;
    el = document.createElement("div");
    el.id = key;
    el.className = "group " + (anyOn ? "online" : "offline");
    el.innerHTML =
      "<div class='host " + (anyOn ? "online" : "offline") + "'><span class='hdot'></span>" + esc(host) +
      "<span class='hbadge'></span></div>";
    grid.appendChild(el);
    groupEls.set(host, el);
    return el;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // SSE 实时名册
  const es = new EventSource("/console/presence/stream");
  es.onmessage = e => {
    try { render(JSON.parse(e.data).presences || []); } catch {}
  };
  es.onerror = () => { summary.textContent = "连接中断，重连中…"; };

  async function sendMessage(to, text) {
    if (!text) return;
    try {
      const r = await fetch("/", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "mailbox/send",
          params: { to, text, from: "human-console" } })
      }).then(r => r.json());
      if (r.error) appendLog("[mail] 发送失败: " + r.error.message);
      else appendLog("[mail] 我 -> " + to + ": " + text);
    } catch (e) { appendLog("[mail] 发送失败: " + e.message); }
  }
  grid.addEventListener("click", e => {
    const btn = e.target.closest("button[data-to]");
    if (!btn) return;
    const input = div_inputOf(btn);
    sendMessage(btn.dataset.to, input.value.trim());
    input.value = "";
  });
  grid.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const input = e.target.closest("input[data-to]");
    if (!input) return;
    sendMessage(input.dataset.to, input.value.trim());
    input.value = "";
  });
  function div_inputOf(btn) {
    return btn.parentElement.querySelector("input");
  }

  // 日志：进页面拉一次全量，之后每 2s 轮询增量（简单可靠）
  let logCount = 0;
  async function pollLogs() {
    try {
      const r = await fetch("/console/logs").then(r => r.json());
      const fresh = (r.logs || []).slice(logCount);
      for (const l of fresh) appendLog(l);
      logCount = (r.logs || []).length;
    } catch {}
  }
  pollLogs();
  setInterval(pollLogs, 2000);

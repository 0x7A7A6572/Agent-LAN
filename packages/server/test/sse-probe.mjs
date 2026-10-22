// 监听控制台 SSE，打印每次推送里该节点的 waitingFor / question 状态与时间戳
//   node sse-probe.mjs [hub] [节点名] [秒数]
const hub = process.argv[2] ?? "127.0.0.1:9600";
const want = process.argv[3] ?? "wb-dev-pc-win11";
const secs = Number(process.argv[4] ?? 25);
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

const ctl = new AbortController();
setTimeout(() => ctl.abort(), secs * 1000);
try {
  const res = await fetch("http://" + hub + "/console/presence/stream", { signal: ctl.signal });
  console.log("[" + ts() + "] SSE 已连上 status=" + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data: ")) continue;
      try {
        const j = JSON.parse(chunk.slice(6));
        const p = (j.presences ?? []).find(x => x.card?.name === want);
        if (!p) { console.log("[" + ts() + "] 推送（无此节点）"); continue; }
        const q = p.question;
        console.log("[" + ts() + "] 推送 waitingFor=" + JSON.stringify(p.waitingFor ?? null) +
          " question=" + (q ? q.id.slice(0, 8) + "/" + (q.answer ? "已答" : "待答") : "无"));
      } catch { /* 忽略非 JSON 行 */ }
    }
  }
  console.log("[" + ts() + "] 流结束");
} catch (err) {
  if (err?.name === "AbortError") console.log("[" + ts() + "] 到时退出");
  else console.log("[" + ts() + "] 失败：" + String(err?.message ?? err));
}

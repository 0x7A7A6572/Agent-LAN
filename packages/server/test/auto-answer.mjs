// 本地联调用：模拟「控制台人工」在几秒内点掉题卡，用来验证 hook 的抢占式代答。
//   node auto-answer.mjs <hub> <节点名> [超时秒数]
// 逻辑：轮询 /console/questions，发现该节点有未答题卡 → 取第一题第一个选项 → POST 答复。
const hub = process.argv[2] ?? "127.0.0.1:9600";
const name = process.argv[3] ?? "wb-dev-pc-win11";
const maxMs = Number(process.argv[4] ?? 30) * 1000;
const base = "http://" + hub;

const t0 = Date.now();
function log(...a) { console.log("[" + ((Date.now() - t0) / 1000).toFixed(1) + "s]", ...a); }

async function main() {
  while (Date.now() - t0 < maxMs) {
    try {
      const list = await fetch(base + "/console/questions").then(r => r.json());
      const arr = Array.isArray(list) ? list : (list.questions ?? []);
      const q = arr.find(x => x?.id && !x.answer && (x.name ?? name) === name);
      if (q) {
        const first = q.questions?.[0];
        const label = first?.options?.[0]?.label;
        if (!label) { log("题卡没选项，改走 other", q.id.slice(0, 8)); }
        const body = {
          name,
          choice: label ? { "0": [label] } : {},
          other: label ? "" : "自动代答：题卡无选项",
          by: "auto-answer"
        };
        log("答 " + q.id.slice(0, 8) + " → 「" + (label ?? body.other) + "」");
        const r = await fetch(base + "/console/questions/answer", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then(async r => ({ status: r.status, body: await r.json() }));
        log("答复 " + r.status, r.body?.ok ? "ok" : JSON.stringify(r.body).slice(0, 160));
        process.exit(r.status === 200 ? 0 : 1);
      }
    } catch (err) {
      log("轮询失败：" + String(err?.message ?? err));
    }
    await new Promise(r => setTimeout(r, 200));
  }
  log("超时：没等到题卡");
  process.exit(2);
}
main();

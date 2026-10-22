// 截图验证：控制台在「有题待答」时的真实渲染（banner + 节点卡入口 + 弹层题卡）
//   node ask-ui-shot.mjs [hub] [节点名]
import { chromium } from "playwright";

const BASE = process.env.MAC_BASE ?? "http://127.0.0.1:9600";
const NAME = process.env.MAC_NODE_SHOT ?? "wb-dev-pc-win11";
const OUT = "D:/codes/multi-agent-connect/docs/images";

const ask = body =>
  fetch(BASE + "/worker/ask", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }).then(r => r.json());

const browser = await chromium.launch({
  executablePath: "C:/Users/hake-/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
  // 关键：宿主环境有 http_proxy，headless chrome 若沿用系统代理，SSE 长连接会被代理掐断
  // —— 表现就是「短请求能过、实时推送永远收不到」，跟用户浏览器里看到的一模一样
  args: ["--no-proxy-server", "--proxy-bypass-list=*"]
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.on("console", m => { if (m.type() === "error") console.log("[页面错误]", m.text().slice(0, 200)); });
await page.goto(BASE + "/console", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const r = await ask({
  name: NAME, kind: "ask", title: "UI 渲染验证",
  questions: [{
    question: "控制台题卡渲染是否正常？", header: "渲染",
    options: [{ label: "正常", description: "banner、入口、弹层三处都在" }, { label: "缺失", description: "某处没渲染出来" }]
  }]
});
console.log("提问已造出:", r.id?.slice(0, 8));
await page.waitForTimeout(1800);
await page.screenshot({ path: OUT + "/ask-ui-1-list.png" });
console.log("① 列表态 ->", OUT + "/ask-ui-1-list.png");

// 找入口：banner 里的「回答」或节点卡上的「回答」
const btn = page.getByRole("button", { name: /回答/ }).first();
const has = await btn.count();
console.log("页面上「回答」按钮数量:", has);
if (has) {
  await btn.click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: OUT + "/ask-ui-2-dialog.png" });
  console.log("② 弹层态 ->", OUT + "/ask-ui-2-dialog.png");
} else {
  const body = await page.locator("body").innerText();
  console.log("页面正文前 600 字：\n" + body.slice(0, 600));
}

await ask({ name: NAME, clear: true });
await browser.close();

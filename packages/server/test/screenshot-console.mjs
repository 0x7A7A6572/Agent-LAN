import { chromium } from "playwright";

const BASE = process.env.MAC_BASE ?? "http://127.0.0.1:9777";
const IMG = "D:/codes/multi-agent-connect/docs/images";

async function mcp(tool, args) {
  const sid = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shot", version: "0" } } }),
  }).then(r => r.headers.get("mcp-session-id"));
  return fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }).then(r => r.text());
}

const ask = body => fetch(BASE + "/worker/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const questions = () => fetch(BASE + "/console/questions").then(r => r.json());

await mcp("mac_check_in", { name: "wb-e2e", agent: "hooktest", description: "提问展示用节点", host: "dev-pc" });

const browser = await chromium.launch({ executablePath: "C:/Users/hake-/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE + "/console", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// ── 场景 A：单题单选 ──
await ask({
  name: "wb-e2e", kind: "ask", title: "hacaller-ui-saas · 修登录页 401 报错",
  questions: [{ header: "部署环境", question: "发布到哪套环境？", options: [
    { label: "预发", description: "先跑一遍冒烟，半小时后我再发生产" },
    { label: "生产", description: "跳过预发，直接灰度 10%" },
    { label: "只出包", description: "不上线，产物给我自己验" },
  ]}],
});
await page.waitForTimeout(1200);
await page.screenshot({ path: IMG + "/q1-card.png" });

await page.getByRole("button", { name: /回答/ }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: IMG + "/q2-dialog-single.png" });

await page.locator('input[type=radio]').first().check();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "提交答复" }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: IMG + "/q3-answered.png" });
console.log("A choice ->", JSON.stringify((await questions()).questions?.[0]?.answer?.choice));

// ── 场景 B：两题（多选 + 自由填写），验证 Progress / 下一步 ──
await ask({
  name: "wb-e2e", kind: "ask", title: "hacaller-ui-saas · 本次一起带上哪些修复",
  questions: [
    { header: "改动范围", question: "这次一起带上哪些修复？（可多选）", multiSelect: true, options: [
      { label: "登录态 401 兜底", description: "token 过期自动跳登录，不再白屏" },
      { label: "订单列表分页", description: "20 条/页，滚到底加载" },
      { label: "H5 适配", description: "移动端订单卡在 375px 下换行" },
    ]},
    { header: "发布窗口", question: "什么时候发？直接说时间" },
  ],
});
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /回答/ }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: IMG + "/q4-dialog-multi.png" });

await page.locator('input[type=checkbox]').nth(0).check();
await page.locator('input[type=checkbox]').nth(2).check();
await page.getByRole("button", { name: "下一题" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: IMG + "/q5-dialog-step2.png" });

await page.getByPlaceholder(/输入你的回答/).last().fill("今晚 22:00");
await page.getByRole("button", { name: "提交答复" }).click();
await page.waitForTimeout(1200);
console.log("B choice ->", JSON.stringify((await questions()).questions?.[0]?.answer?.choice));
await page.screenshot({ path: IMG + "/q6-multi-answered.png" });

await browser.close();
console.log("done");

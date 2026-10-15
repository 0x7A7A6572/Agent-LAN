
// keyed render 核心逻辑的单测（与 console.html 相同算法）
const cards = new Map();
const groups = new Map();
let buildCalls = 0, updateCalls = 0;

function buildCard(p) { buildCalls++; return { name: p.card.name, state: p.online }; }
function render(presences) {
  const seen = new Set();
  for (const p of presences) {
    seen.add(p.card.name);
    let c = cards.get(p.card.name);
    if (!c) { c = buildCard(p); cards.set(p.card.name, c); }
    else if (c.state !== p.online) { updateCalls++; c.state = p.online; }
  }
  for (const [name, c] of cards) if (!seen.has(name)) cards.delete(name);
}

// 第1轮：2节点
render([{card:{name:"a"},online:true},{card:{name:"b"},online:true}]);
// 第2轮：同节点仅心跳时间变化（最频繁的场景）
render([{card:{name:"a"},online:true},{card:{name:"b"},online:true}]);
// 第3轮：状态变化
render([{card:{name:"a"},online:false},{card:{name:"b"},online:true}]);
// 第4轮：新增+删除
render([{card:{name:"b"},online:true},{card:{name:"c"},online:true}]);

console.log("buildCalls:", buildCalls, "(期望 3：a,b,c 各一次)");
console.log("updateCalls:", updateCalls, "(期望 1：只有 a 的状态变化)");
console.log("cards:", [...cards.keys()].join(","), "(期望 b,c)");

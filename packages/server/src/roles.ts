// 角色库：hub 侧权威存储，节点心跳不覆盖
import fs from "node:fs";

/** 一个角色条目：名字是节点指派的唯一依据，其余都是给人看的 */
export interface RoleDef {
  name: string;
  /** 一句话职责，控制台卡片副标题；空则不显示 */
  desc: string;
}

type RoleInput = string | { name?: unknown; desc?: unknown; label?: unknown };

/** 缺省角色，控制台可增删改 */
export const DEFAULT_ROLES: RoleDef[] = [
  { name: "requirement", desc: "" },
  { name: "product", desc: "" },
  { name: "frontend", desc: "" },
  { name: "backend", desc: "" },
  { name: "test", desc: "" },
  { name: "docs", desc: "" }
];

/** .roles.json 结构：节点映射 + 角色列表，二者同文件持久化 */
interface RolesFile {
  allowed?: RoleInput[];
  nodes?: Record<string, string>;
}

export function normalizeRole(input: RoleInput): RoleDef | null {
  const name = String(typeof input === "string" ? input : (input?.name ?? "")).trim();
  if (!name) return null;
  const raw = typeof input === "string" ? "" : (input?.desc ?? input?.label ?? "");
  return { name, desc: String(raw ?? "").trim() };
}

export class RoleStore {
  private map = new Map<string, string>();
  private allowedList: RoleDef[];

  constructor(private filePath: string) {
    this.allowedList = [...DEFAULT_ROLES];
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RolesFile;
      if (Array.isArray(raw.allowed)) {
        // 旧文件是纯字符串数组，按新结构读入，desc 留空
        this.allowedList = raw.allowed
          .map(r => normalizeRole(r))
          .filter((r): r is RoleDef => !!r);
      }
      if (raw.nodes) for (const [k, v] of Object.entries(raw.nodes)) this.map.set(k, v);
    } catch { /* 首次启动无文件；坏文件同 orders 策略，小量数据直接容忍 */ }
    this.filePath = filePath;
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({
        allowed: this.allowedList,
        nodes: Object.fromEntries(this.map)
      }, null, 2));
    } catch { /* 落盘失败下次变更重试 */ }
  }

  /** 当前角色列表，控制台据此渲染选人界面 */
  get allowed(): readonly RoleDef[] {
    return this.allowedList;
  }

  /** 只取名字，节点指派校验与 PM 提示词用 */
  get names(): string[] {
    return this.allowedList.map(r => r.name);
  }

  /** 全量替换角色列表，按名字去重；同名后到的覆盖 desc */
  setAllowed(roles: RoleInput[]): readonly RoleDef[] {
    const out: RoleDef[] = [];
    for (const r of roles) {
      const def = normalizeRole(r);
      if (!def) continue;
      const hit = out.findIndex(o => o.name === def.name);
      if (hit < 0) out.push(def);
      else if (def.desc) out[hit] = def;
    }
    this.allowedList = out;
    this.save();
    return out;
  }

  set(name: string, role: string): void {
    if (role && !this.allowedList.some(r => r.name === role)) throw new Error("非法角色: " + role);
    if (role) this.map.set(name, role);
    else this.map.delete(name);
    this.save();
  }

  get(name: string): string {
    return this.map.get(name) ?? "";
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

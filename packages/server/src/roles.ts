// 节点角色映射：hub 侧权威存储，节点心跳不覆盖
import fs from "node:fs";

/** 缺省允许的角色集合，控制台可增删 */
export const DEFAULT_ROLES = ["requirement", "product", "frontend", "backend", "test", "pm", "docs"] as const;

/** .roles.json 结构：节点映射 + 允许列表，二者同文件持久化 */
interface RolesFile {
  allowed?: string[];
  nodes?: Record<string, string>;
}

export class RoleStore {
  private map = new Map<string, string>();
  private allowedList: string[];

  constructor(private filePath: string) {
    this.allowedList = [...DEFAULT_ROLES];
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RolesFile;
      if (Array.isArray(raw.allowed)) this.allowedList = raw.allowed;
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

  /** 当前允许的角色集合，控制台据此渲染选人界面 */
  get allowed(): readonly string[] {
    return this.allowedList;
  }

  /** 全量替换允许列表，返回去重结果 */
  setAllowed(roles: string[]): readonly string[] {
    const seen: string[] = [];
    for (const r of roles) {
      const v = String(r).trim().toLowerCase();
      if (v && !seen.includes(v)) seen.push(v);
    }
    this.allowedList = seen;
    this.save();
    return seen;
  }

  set(name: string, role: string): void {
    if (role && !this.allowedList.includes(role)) throw new Error("非法角色: " + role);
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

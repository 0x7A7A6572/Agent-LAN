// 节点角色映射：hub 侧权威存储，节点心跳不覆盖
import fs from "node:fs";

export const ROLES = ["requirement", "product", "frontend", "backend", "test", "pm", "docs"] as const;
export type Role = (typeof ROLES)[number] | "";

export class RoleStore {
  private map = new Map<string, string>();

  constructor(private filePath: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch { /* 首次启动无文件；坏文件同 orders 策略，小量数据直接容忍 */ }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch { /* 落盘失败下次变更重试 */ }
  }

  set(name: string, role: string): void {
    if (role && !ROLES.includes(role as any)) throw new Error("非法角色: " + role);
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

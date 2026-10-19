// 文件通道：局域网文件存取，Artifact 用 URL 引用不进消息体
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class FileChannel {
  private dir: string;
  /** 对外可访问的根地址，如 http://192.168.1.1:9600 */
  publicRoot: string;

  /** 取本机第一个非内环 IPv4，供跨机器引用 */
  static lanAddress(): string {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) return ni.address;
      }
    }
    return "127.0.0.1";
  }

  constructor(storageDir: string, publicRoot: string) {
    this.dir = storageDir;
    this.publicRoot = publicRoot.replace(/\/$/, "");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 保存文件，返回可局域网直取的 URI */
  save(name: string, data: Buffer | string): string {
    const id = randomUUID().slice(0, 8);
    const safe = path.basename(name).replace(/[\\/:*?"<>|]/g, "_");
    const stored = id + "-" + safe;
    fs.writeFileSync(path.join(this.dir, stored), data);
    return this.publicRoot + "/files/" + stored;
  }

  /** 按 URL 末段读取本地文件 */
  open(storedName: string): Buffer | undefined {
    const safe = path.basename(storedName);
    const p = path.join(this.dir, safe);
    return fs.existsSync(p) ? fs.readFileSync(p) : undefined;
  }

  /** 按展示名反查文件在磁盘上的绝对路径，找不到返回 undefined */
  dirOf(name: string): string | undefined {
    const safe = name.replace(/[\/:*?"<>|]/g, "_");
    for (const f of fs.readdirSync(this.dir)) {
      // 存储名=uuid前缀-原名，匹配后缀即可
      if (f.endsWith("-" + safe)) return path.join(this.dir, f);
    }
    return undefined;
  }

  /** 资料库列表：按修改时间倒序 */
  list(): { name: string; size: number; mtime: string; uri: string }[] {
    return fs.readdirSync(this.dir)
      .filter(f => fs.statSync(path.join(this.dir, f)).isFile())
      .map(f => {
        const st = fs.statSync(path.join(this.dir, f));
        const dot = f.indexOf("-");
        return {
          name: dot > 0 ? f.slice(dot + 1) : f,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          uri: this.publicRoot + "/files/" + f,
        };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }
}

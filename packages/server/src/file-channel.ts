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
}

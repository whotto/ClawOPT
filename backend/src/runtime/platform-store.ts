/**
 * 运行时平面自己的落盘：`<ClawOPT 数据目录>/runtime/` 下的私有文件与本机加密。
 *
 * - 所有写入走 `core/files` 的原子写（同目录临时文件 + fsync + rename），权限 0600，目录 0700；
 * - 所有读取只经这里的 `readPrivateText`——fs 调用点棘轮上只多这一处；
 * - 加密：AES-256-GCM，密钥是数据目录里一个 0600 的随机 32 字节文件（base64），
 *   AAD 由调用方给出、绑定这份密文所属的全部坐标：文件被挪到别的坐标下或被改动，解密即失败。
 *
 * 这把本机密钥防的是「恢复文件被单独拷走 / 被改」，不防拿到整个数据目录的人——
 * 那个人本来就能读 SQLite 与 openclaw.json。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { writeFileAtomicSync } from '../core/files';
import { clawoptDataDir } from '../core/paths';

export function defaultRuntimeDataDir(): string {
  return path.join(clawoptDataDir, 'runtime');
}

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 目录不归我们所有时改不了权限：不致命，文件本身仍是 0600。
  }
}

/** 读私有文本文件；不存在返回 null。只读普通文件（不跟命名管道之类的东西较劲）。 */
export function readPrivateText(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function writePrivateText(filePath: string, contents: string): void {
  ensurePrivateDir(path.dirname(filePath));
  writeFileAtomicSync(filePath, contents);
  fs.chmodSync(filePath, 0o600);
}

export interface SealedSecret {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export class LocalSecretBox {
  private key: Buffer | null = null;

  constructor(private readonly keyFile: string) {}

  private loadKey(): Buffer {
    if (this.key) return this.key;
    const existing = readPrivateText(this.keyFile);
    if (existing !== null) {
      const key = Buffer.from(existing.trim(), 'base64');
      if (key.length !== 32) throw new Error('runtime secret key file is corrupt');
      try {
        if ((fs.statSync(this.keyFile).mode & 0o077) !== 0) fs.chmodSync(this.keyFile, 0o600);
      } catch {
        // 权限收不紧不影响加解密本身。
      }
      this.key = key;
      return key;
    }
    const key = crypto.randomBytes(32);
    writePrivateText(this.keyFile, key.toString('base64'));
    this.key = key;
    return key;
  }

  seal(plaintext: string, aad: string): SealedSecret {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.loadKey(), iv);
    cipher.setAAD(Buffer.from(aad, 'utf-8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }

  /** 密文、标签或 AAD 任何一处对不上都返回 null（不抛：恢复路径上一个坏文件不该拖垮启动）。 */
  unseal(sealed: unknown, aad: string): string | null {
    const box = sealed as Partial<SealedSecret> | null;
    if (!box || box.v !== 1 || box.alg !== 'aes-256-gcm' || !box.iv || !box.tag || typeof box.ciphertext !== 'string') return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.loadKey(), Buffer.from(box.iv, 'base64'));
      decipher.setAAD(Buffer.from(aad, 'utf-8'));
      decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]).toString('utf-8');
    } catch {
      return null;
    }
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a, 'utf-8').digest();
  const right = crypto.createHash('sha256').update(b, 'utf-8').digest();
  return crypto.timingSafeEqual(left, right) && a.length === b.length;
}

/**
 * SSH 主机密钥管理：ClawOPT 自己的 known_hosts（`<数据目录>/file-manager/known_hosts`，0600）。
 *
 * 流程只有一条：扫描（`ssh-keyscan`）→ 界面显示 SHA256 指纹 → 管理员核对后确认 → 按扫描时记下的那几行追加。
 * 确认只收扫描 id + 指纹，不收客户端给的密钥文本——客户端改不了写进去的内容。
 */
import { execFile } from 'child_process';
import crypto from 'crypto';

import { fmError } from './file-manager-errors';
import { readSmallText, writeSmallTextAtomic } from './file-manager-fs';
import { validateSshHost, validateSshPort } from './backends/ssh-backend';

export type KnownHostKey = { hostPattern: string; keyType: string; fingerprint: string; line: string };

export type KeyscanRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string; missing: boolean }>;

const SCAN_TTL_MS = 10 * 60 * 1000;

export const defaultKeyscanRunner: KeyscanRunner = (args) => new Promise((resolve) => {
  execFile('ssh-keyscan', args, { timeout: 15_000, maxBuffer: 256 * 1024, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }, (error, stdout, stderr) => {
    const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: err?.code === 'ENOENT' });
  });
});

export function fingerprintOf(base64Key: string): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** known_hosts 的一行（不含注释、@cert-authority 等标记行照原样保留但不列出）。 */
export function parseKnownHostsLine(line: string): KnownHostKey | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;
  const [hostPattern, keyType, key] = parts;
  if (!/^(ssh-|ecdsa-|sk-)/.test(keyType) || !/^[A-Za-z0-9+/=]+$/.test(key)) return null;
  return { hostPattern, keyType, fingerprint: fingerprintOf(key), line: `${hostPattern} ${keyType} ${key}` };
}

export function hostPatternFor(host: string, port: number): string {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  return port === 22 ? bare : `[${bare}]:${port}`;
}

export function createKnownHosts(options: { file: string; runner?: KeyscanRunner; now?: () => number }) {
  const runner = options.runner ?? defaultKeyscanRunner;
  const now = options.now ?? Date.now;
  const scans = new Map<string, { at: number; hostPattern: string; keys: KnownHostKey[] }>();

  async function readLines(): Promise<string[]> {
    const text = await readSmallText(options.file);
    return text ? text.split('\n') : [];
  }

  return {
    async list(): Promise<KnownHostKey[]> {
      return (await readLines()).map(parseKnownHostsLine).filter((entry): entry is KnownHostKey => entry !== null);
    },

    async scan(input: { host: unknown; port: unknown }): Promise<{ scanId: string; hostPattern: string; keys: Array<Omit<KnownHostKey, 'line'>>; alreadyKnown: string[] }> {
      const host = validateSshHost(input.host);
      const port = validateSshPort(input.port);
      const result = await runner(['-T', '5', '-p', String(port), '--', host.replace(/^\[(.*)\]$/, '$1')]);
      if (result.missing) throw fmError.backendUnavailable('host.sshMissing');
      const hostPattern = hostPatternFor(host, port);
      const keys = result.stdout.split('\n')
        .map(parseKnownHostsLine)
        .filter((entry): entry is KnownHostKey => entry !== null)
        // ssh-keyscan 输出里的主机字段按 known_hosts 形状写，这里统一成我们要写入的形状。
        .map((entry) => ({ ...entry, hostPattern, line: `${hostPattern} ${entry.keyType} ${entry.line.split(' ')[2]}` }));
      if (keys.length === 0) throw fmError.backendError(result.stderr.split('\n').filter(Boolean).slice(-2).join('\n') || null);
      for (const [id, scan] of scans) if (now() - scan.at > SCAN_TTL_MS) scans.delete(id);
      const scanId = crypto.randomBytes(16).toString('hex');
      scans.set(scanId, { at: now(), hostPattern, keys });
      const known = new Set((await this.list()).map((entry) => `${entry.hostPattern} ${entry.fingerprint}`));
      return {
        scanId,
        hostPattern,
        keys: keys.map(({ line: _line, ...rest }) => rest),
        alreadyKnown: keys.filter((key) => known.has(`${key.hostPattern} ${key.fingerprint}`)).map((key) => key.fingerprint),
      };
    },

    /** 确认扫描结果里的指纹：只追加那一次扫描拿到的行。 */
    async trust(input: { scanId: unknown; fingerprints: unknown }): Promise<KnownHostKey[]> {
      const scan = typeof input.scanId === 'string' ? scans.get(input.scanId) : undefined;
      if (!scan || now() - scan.at > SCAN_TTL_MS) throw fmError.invalidInput('scanId');
      const wanted = Array.isArray(input.fingerprints) ? new Set(input.fingerprints.filter((item): item is string => typeof item === 'string')) : new Set<string>();
      const chosen = scan.keys.filter((key) => wanted.has(key.fingerprint));
      if (chosen.length === 0) throw fmError.invalidInput('fingerprints');
      const lines = (await readLines()).filter((line) => line.trim());
      const existing = new Set(lines.map(parseKnownHostsLine).filter(Boolean).map((entry) => `${entry!.hostPattern} ${entry!.fingerprint}`));
      for (const key of chosen) if (!existing.has(`${key.hostPattern} ${key.fingerprint}`)) lines.push(key.line);
      await writeSmallTextAtomic(options.file, `${lines.join('\n')}\n`);
      if (input.scanId) scans.delete(String(input.scanId));
      return this.list();
    },

    async remove(input: { hostPattern: unknown; fingerprint: unknown }): Promise<KnownHostKey[]> {
      if (typeof input.hostPattern !== 'string' || typeof input.fingerprint !== 'string') throw fmError.invalidInput('fingerprint');
      const lines = (await readLines()).filter((line) => line.trim());
      const kept = lines.filter((line) => {
        const entry = parseKnownHostsLine(line);
        return !(entry && entry.hostPattern === input.hostPattern && entry.fingerprint === input.fingerprint);
      });
      if (kept.length === lines.length) throw fmError.notFound();
      await writeSmallTextAtomic(options.file, kept.length ? `${kept.join('\n')}\n` : '');
      return this.list();
    },
  };
}

export type KnownHosts = ReturnType<typeof createKnownHosts>;

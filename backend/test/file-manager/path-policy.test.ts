/**
 * 路径策略：相对路径校验，以及敏感文件判据与 `core/files/served-paths.ts` 的一致性（两份清单分家会红）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveServablePath } from '../../src/core/files';
import { isDeniedRelativePath, normalizeRelativePath, validateEntryName } from '../../src/workspace/files/manager/path-policy';

describe('normalizeRelativePath', () => {
  it('规范化合法路径', () => {
    expect(normalizeRelativePath('')).toBe('');
    expect(normalizeRelativePath(undefined)).toBe('');
    expect(normalizeRelativePath('a/./b//c/')).toBe('a/b/c');
  });

  it('拒绝 `..`、绝对路径、Windows 盘符、NUL、反斜杠、非字符串', () => {
    for (const bad of ['..', 'a/../b', '../x', '/etc/passwd', 'C:/x', 'a\0b', 'a\\b', 42, { path: 'x' }]) {
      expect(() => normalizeRelativePath(bad), JSON.stringify(bad)).toThrow(/invalidPath/);
    }
  });

  it('文件名不许带分隔符、换行或是 . / ..', () => {
    for (const bad of ['a/b', '.', '..', 'x\ny', '']) expect(() => validateEntryName(bad), JSON.stringify(bad)).toThrow(/invalidPath/);
    expect(validateEntryName(' ok.txt ')).toBe('ok.txt');
  });
});

describe('敏感文件判据与可服务路径闸门一致', () => {
  let home: string;
  let previousHome: string | undefined;
  const SAMPLES = [
    'README.md', 'notes/todo.txt', '.env', '.env.production', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'tls.key', 'cert.p12',
    'data.sqlite', 'data.sqlite-wal', 'openclaw.json', 'auth-profiles.json', 'credentials.json', '.htpasswd',
    '.ssh/config', '.aws/credentials', '.gnupg/pubring', '.config/app.json', 'agents/main/x.json', 'node_modules/p/index.js', '.git/HEAD',
    'my.env.txt', 'keys.txt', 'sqlite.md',
  ];

  beforeAll(() => {
    previousHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-fm-policy-')));
    process.env.HOME = home;
    const ws = path.join(home, '.openclaw', 'workspace-a');
    for (const sample of SAMPLES) {
      fs.mkdirSync(path.dirname(path.join(ws, sample)), { recursive: true });
      fs.writeFileSync(path.join(ws, sample), 'x');
    }
  });

  afterAll(() => {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('每个样本：文件管理器拒绝 ⇔ 可服务路径闸门以 deniedFile 拒绝', () => {
    const mismatches: string[] = [];
    for (const sample of SAMPLES) {
      const verdict = resolveServablePath(path.join(home, '.openclaw', 'workspace-a', sample));
      const servedDenied = !verdict.ok && verdict.reason === 'deniedFile';
      if (servedDenied !== isDeniedRelativePath(sample)) mismatches.push(`${sample}: served=${servedDenied} fm=${isDeniedRelativePath(sample)}`);
    }
    expect(mismatches).toEqual([]);
    expect(SAMPLES.filter((sample) => isDeniedRelativePath(sample)).length).toBeGreaterThan(15);
  });
});

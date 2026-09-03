/**
 * 引擎版本探测 —— S2-A1。
 *
 * 这批用例钉住三件事，每一件都有生产机上的实测依据：
 *
 * 1. **取不到就是 `unknown`**，不猜。猜错的代价不对称：猜成 2.x 会让写入落到
 *    `agents.entries`，而 1.x 的引擎完全看不见那个 Agent 且没有恢复路径；
 *    猜成 1.x 只会多留一个废弃键，doctor 一跑就迁移。
 * 2. **不 shell out**。生产机实测 `openclaw --version` 退出码 **1**——
 *    系统 Node 是 v20 而 openclaw 要 ≥22，同一台机器上这条命令成不成功
 *    取决于谁的 PATH 在前。这个雷本仓库踩过一次（commit c2c0637）。
 * 3. **不用 semver 比版本**。`2026.7.1-2` 里的 `-2` 是同月重发次数，
 *    不是 semver 的 prerelease；拿 semver 比会得出「2026.7.1-2 < 2026.7.1」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseOpenClawVersion,
  compareOpenClawVersion,
  usesEntriesSchema,
  detectOpenClawVersion,
  unknownVersion,
  type OpenClawVersion,
} from '../src/openclaw-version';

const v = (raw: string): OpenClawVersion => {
  const r = parseOpenClawVersion(raw);
  if (!r.known) throw new Error(`用例自身写错了：${raw} 解析不出来`);
  return r;
};

describe('版本解析', () => {
  it('解析生产机上的真实版本串 2026.7.1-2', () => {
    expect(v('2026.7.1-2')).toMatchObject({ known: true, year: 2026, month: 7, patch: 1 });
  });

  it('解析上游 2.0 的版本串 2026.8.1 与补丁 2026.8.2', () => {
    expect(v('2026.8.1')).toMatchObject({ year: 2026, month: 8, patch: 1 });
    expect(v('2026.8.2')).toMatchObject({ year: 2026, month: 8, patch: 2 });
  });

  it('解析不了时返回 unknown 并带上原因，**不返回任何具体版本**', () => {
    for (const bad of ['', '   ', 'latest', 'v2', '2026.8', undefined, null, 42, {}]) {
      const r = parseOpenClawVersion(bad as unknown);
      expect(r.known).toBe(false);
      // 反向断言：不能有任何版本字段泄到 unknown 结果上
      expect((r as Record<string, unknown>).year).toBeUndefined();
    }
  });
});

describe('版本比较：按 年→月→序号，不按 semver', () => {
  it('2026.8.1 比 2026.7.1 新', () => {
    expect(compareOpenClawVersion(v('2026.8.1'), v('2026.7.1'))).toBeGreaterThan(0);
  });

  it('2026.8.2 比 2026.8.1 新', () => {
    expect(compareOpenClawVersion(v('2026.8.2'), v('2026.8.1'))).toBeGreaterThan(0);
  });

  it('2027.1.1 比 2026.12.9 新（跨年，月份大的不一定新）', () => {
    expect(compareOpenClawVersion(v('2027.1.1'), v('2026.12.9'))).toBeGreaterThan(0);
  });

  it('`2026.7.1-2` 与 `2026.7.1` 相等——后缀是同月重发次数，不是 semver prerelease', () => {
    // semver 会判 2026.7.1-2 < 2026.7.1（prerelease 排在正式版前），那是错的。
    expect(compareOpenClawVersion(v('2026.7.1-2'), v('2026.7.1'))).toBe(0);
  });
});

describe('entries schema 判据', () => {
  it('生产机现状 2026.7.1-2 → 不用 entries', () => {
    expect(usesEntriesSchema(v('2026.7.1-2'))).toBe(false);
  });

  it('2026.8.1 与 2026.8.2 → 用 entries', () => {
    expect(usesEntriesSchema(v('2026.8.1'))).toBe(true);
    expect(usesEntriesSchema(v('2026.8.2'))).toBe(true);
  });

  it('**unknown → false**（朝代价小的方向失败）', () => {
    // 这条是整个模块最重要的断言。猜成 true 会让 Agent 在 1.x 引擎上彻底消失。
    expect(usesEntriesSchema(unknownVersion('notInstalled'))).toBe(false);
  });
});

describe('探测：从安装目录的 package.json 读，不起进程', () => {
  it('读到合法 package.json 时返回解析后的版本', () => {
    // 第一版这条用例是坏的：注入的 existsSync 只认一个临时目录里的路径，
    // 而那个路径根本不在候选列表里，于是断言写的是 `known === false`——
    // **标题说「返回解析后的版本」，断言却证明了它探不到**。
    // 这是 lessons L7 那个毛病（断言弱于/反于标题），这次在写的时候抓住了。
    //
    // 正确做法：让注入的 existsSync 认下候选列表里的第一个路径，
    // 让 readFileSync 交出真实形状的内容，真的走完读取分支。
    const GLOBAL_PKG = '/usr/lib/node_modules/openclaw/package.json';
    const r = detectOpenClawVersion(
      ((p: fs.PathOrFileDescriptor) => {
        expect(String(p)).toBe(GLOBAL_PKG);
        return JSON.stringify({ name: 'openclaw', version: '2026.8.2' });
      }) as unknown as typeof fs.readFileSync,
      (() => ({ isFile: () => true })) as unknown as typeof fs.statSync,
      ((p: fs.PathLike) => String(p) === GLOBAL_PKG) as unknown as typeof fs.existsSync,
    );
    expect(r).toMatchObject({ known: true, raw: '2026.8.2', year: 2026, month: 8, patch: 2 });
  });

  it('生产机的真实安装形态（/usr/lib/node_modules，版本 2026.7.1-2）能被认出来', () => {
    // 这是 2026-09-03 在 64.186.235.99 上实测到的形态，不是构造的场景。
    const GLOBAL_PKG = '/usr/lib/node_modules/openclaw/package.json';
    const r = detectOpenClawVersion(
      (() => JSON.stringify({ name: 'openclaw', version: '2026.7.1-2' })) as unknown as typeof fs.readFileSync,
      (() => ({ isFile: () => true })) as unknown as typeof fs.statSync,
      ((p: fs.PathLike) => String(p) === GLOBAL_PKG) as unknown as typeof fs.existsSync,
    );
    expect(r).toMatchObject({ known: true, raw: '2026.7.1-2' });
    expect(usesEntriesSchema(r)).toBe(false);
  });

  it('一个候选都不存在时返回 unknown/notInstalled', () => {
    const r = detectOpenClawVersion(fs.readFileSync, fs.statSync, () => false);
    expect(r).toEqual({ known: false, reason: 'notInstalled' });
  });

  it('候选存在但内容读不动时返回 unknown/installedButVersionUnreadable，**不抛**', () => {
    const r = detectOpenClawVersion(
      () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
      (() => ({ isFile: () => true })) as unknown as typeof fs.statSync,
      () => true,
    );
    expect(r).toEqual({ known: false, reason: 'installedButVersionUnreadable' });
  });

  it('候选是命名管道（非普通文件）时跳过，不挂死', () => {
    const started = Date.now();
    const r = detectOpenClawVersion(
      () => { throw new Error('不该走到读取'); },
      (() => ({ isFile: () => false })) as unknown as typeof fs.statSync,
      () => true,
    );
    expect(r.known).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

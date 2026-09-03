/**
 * 配置的原子写入 —— 对抗测试第三轮 CRITICAL。
 *
 * 背景：全仓库原来有六处 `fs.writeFileSync(configPath, JSON.stringify(...))`。
 * `writeFileSync` **先截断成 0 字节再写**，中间那个窗口里文件是空的。
 * 对抗测试实测：7 次写入过程中，并发读者**三次**观察到长度为 0。
 *
 * 这不是「读到半截」这么轻——`openclaw.json` 是用户主机上唯一一份 OpenClaw 配置，
 * 含 gateway 凭据、全部模型 apiKey、全部 Agent 定义，而 ClawOPT 没有为它做过备份。
 * 进程在那个窗口里被杀（OOM / systemctl restart / 断电 / Restart=always 的崩溃循环），
 * 用户就永久失去它。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeFileAtomicSync, writeJsonAtomicSync } from '../src/config-atomic-write';

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-atomic-'));
  target = path.join(dir, 'openclaw.json');
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test] 清理临时目录失败：', err);
  }
});

describe('配置写入是原子的：读者永远看不到零长度或半截内容', () => {
  /**
   * **这条用例证明不了截断窗口不存在** —— 如实标注。
   *
   * 零长度窗口只有**另一个进程**在写入进行中读取才能观察到；
   * 单线程同步用例里写完才读，那个窗口早已关闭。第一版这条用例的标题写的是
   * 「读者永远看不到零长度」，而红证时它在**直写的旧代码上也是绿的**——
   * 断言弱于标题，正是 `.harness/lessons.md` L3 记的那个毛病。
   *
   * 截断窗口的真实证据来自对抗测试（跨进程观察：7 次写入中 3 次读到 0 字节），
   * 记在 `.harness/verify-sprint1-adversarial-round3.md`。
   * 这条用例保留的价值只有一个：**结果永远是一份完整可解析的 JSON**。
   * 真正会红的守卫是下面两条（失败不留半截、权限不放宽）。
   */
  it('多轮写入后，磁盘上永远是一份完整可解析的 JSON（不证明窗口不存在，见上）', () => {
    const big = { agents: { list: Array.from({ length: 4000 }, (_, i) => ({ id: `a${i}`, workspace: `/w/${i}` })) } };
    writeJsonAtomicSync(target, big);
    expect(fs.statSync(target).size).toBeGreaterThan(100_000);

    for (let round = 0; round < 12; round++) {
      writeJsonAtomicSync(target, { ...big, round });
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
      expect(parsed.round).toBe(round);
    }
  });

  it('写入失败时不留下半截文件，原文件保持原样', () => {
    writeJsonAtomicSync(target, { keep: 'me' });
    const before = fs.readFileSync(target, 'utf-8');

    // 目标所在目录设为只读，制造一次真实的写入失败。
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => writeJsonAtomicSync(target, { replaced: true })).toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }

    // 失败必须让原文件毫发无伤——这正是「先写临时文件再 rename」的意义。
    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    // 且不留临时文件残骸。
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('保留目标文件原有的权限位，不把含凭据的 600 悄悄放宽成 644', () => {
    if (process.getuid && process.getuid() === 0) return; // root 下权限位没有意义
    writeFileAtomicSync(target, '{}');
    fs.chmodSync(target, 0o600);

    writeJsonAtomicSync(target, { token: 'secret' });

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('目标文件不存在时，新建的权限是 600 而不是默认的 644', () => {
    if (process.getuid && process.getuid() === 0) return;
    writeJsonAtomicSync(target, { fresh: true });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});

/**
 * 符号链接必须穿透，不能被替换 —— 对抗测试第四/五轮 MEDIUM（两轮都没修）。
 *
 * `rename()` 替换的是路径本身：目标若是一条软链，rename 过去会把软链变成普通文件，
 * 链接关系**静默消失**。用户如果把 openclaw.json 软链到别处（多机共享、同步盘），
 * 我们会在他毫不知情的情况下把那个安排拆掉——而且只有下次他去改「真正那份」时
 * 才会发现改动没生效。
 */
describe('目标是符号链接时穿透写入，不把链接换成普通文件', () => {
  it('写完之后软链仍是软链，且真实文件的内容被更新了', () => {
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir);
    const realFile = path.join(realDir, 'actual.json');
    fs.writeFileSync(realFile, JSON.stringify({ v: 'old' }));

    const link = path.join(dir, 'openclaw.json');
    fs.symlinkSync(realFile, link);

    writeJsonAtomicSync(link, { v: 'new' });

    // 三个方向一起断，缺一条都可能被更糟的实现蒙混：
    // ① 链接还在（没被换成普通文件）
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // ② 它还指向原来那个文件
    expect(fs.readlinkSync(link)).toBe(realFile);
    // ③ 真实文件的内容确实更新了（不是「保住了链接但没写进去」）
    expect(JSON.parse(fs.readFileSync(realFile, 'utf-8'))).toEqual({ v: 'new' });
  });

  it('目标不存在时照常新建，不被 realpath 的抛错拖住', () => {
    const fresh = path.join(dir, 'never-existed.json');
    writeJsonAtomicSync(fresh, { ok: true });
    expect(JSON.parse(fs.readFileSync(fresh, 'utf-8'))).toEqual({ ok: true });
  });
});

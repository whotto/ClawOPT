/**
 * 群成员的运行时维度 + 外部会话映射表。
 *
 * ## 这是路线 B 的落点
 *
 * 外部 Agent **不写进 `openclaw.json`**——那是 v1.5.0 用一次线上事故换来的边界。
 * 它们是 ClawOPT 自己的群成员，所以运行时信息落在 `group_members` 上，
 * 会话 UUID 落在一张单独的映射表里。
 *
 * ## 为什么会话要单独一张表
 *
 * 实测（claude 2.1.269）：冷起一次 $0.0594，续话 $0.0067，**差 8.8 倍**。
 * 所以「这个成员在这个群里的会话 id」必须持久化，进程重启也要认得——
 * 它不是缓存，丢了就等于每轮都按冷起计价。
 *
 * ## 守的是什么
 *
 * 迁移的幂等性，和**级联删除**。这个库的删除是手写的（`deleteGroupChat` 里
 * 一行行 DELETE），不是 FK 驱动的——新加一张表而忘了在那里补一行，
 * 后果不是报错，是孤儿行在库里越积越多，而且没人会发现。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let prevHome: string | undefined;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-extsess-'));
  prevHome = process.env.HOME;
  prevDataDir = process.env.CLAWOPT_DATA_DIR;
  process.env.HOME = tmpHome;
  process.env.CLAWOPT_DATA_DIR = '.clawopt-test';
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevDataDir === undefined) delete process.env.CLAWOPT_DATA_DIR;
  else process.env.CLAWOPT_DATA_DIR = prevDataDir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  catch (err) { console.warn('[test] 清理失败：', err); }
});

async function freshDb(): Promise<any> {
  const mod = await import('../src/db');
  return new (mod.default as any)();
}

const seedGroup = (db: any, groupId = 'g1') => {
  db.saveGroupChat({ id: groupId, name: '测试群', description: '', position: 0 });
  db.saveGroupMember({ id: 'm1', group_id: groupId, agent_id: 'a1', display_name: '甲', role_description: '', position: 0 });
  db.saveGroupMember({ id: 'm2', group_id: groupId, agent_id: 'a2', display_name: '乙', role_description: '', position: 1 });
};

describe('group_members 的运行时维度', () => {
  it('已有成员默认是 openclaw，而不是 NULL', async () => {
    const db = await freshDb();
    seedGroup(db);
    const [first] = db.getGroupMembers('g1');
    expect(first.runtime, '默认值缺失会让判断处处要写 ?? "openclaw"').toBe('openclaw');
    expect(first.external_config ?? null).toBeNull();
  });

  it('能存下外部运行时与它的配置', async () => {
    const db = await freshDb();
    db.saveGroupChat({ id: 'g1', name: '测试群', description: '', position: 0 });
    db.saveGroupMember({
      id: 'm1', group_id: 'g1', agent_id: 'lead-engineer', display_name: 'Lead Engineer',
      role_description: '', position: 0,
      runtime: 'claude-code',
      external_config: JSON.stringify({ workingDir: '/srv/app', model: 'claude-sonnet-5' }),
    });

    const [member] = db.getGroupMembers('g1');
    expect(member.runtime).toBe('claude-code');
    expect(JSON.parse(member.external_config)).toEqual({ workingDir: '/srv/app', model: 'claude-sonnet-5' });
  });

  it('更新成员时不把已有的运行时洗掉', async () => {
    const db = await freshDb();
    db.saveGroupChat({ id: 'g1', name: '测试群', description: '', position: 0 });
    db.saveGroupMember({
      id: 'm1', group_id: 'g1', agent_id: 'x', display_name: '原名', role_description: '', position: 0,
      runtime: 'claude-code', external_config: '{"workingDir":"/srv/app"}',
    });
    // 只改显示名的一次保存，不该顺手把运行时退回 openclaw。
    db.saveGroupMember({ id: 'm1', group_id: 'g1', agent_id: 'x', display_name: '新名', role_description: '', position: 0 });

    const [member] = db.getGroupMembers('g1');
    expect(member.display_name).toBe('新名');
    expect(member.runtime, '一次无关的保存把运行时冲掉了').toBe('claude-code');
  });
});

describe('外部会话映射', () => {
  it('按 (群, 成员) 存取会话 UUID', async () => {
    const db = await freshDb();
    seedGroup(db);
    db.setExternalSession('g1', 'm1', '1e2dae2d-eea3-4bee-8f7d-073833cdde12');
    expect(db.getExternalSession('g1', 'm1')).toBe('1e2dae2d-eea3-4bee-8f7d-073833cdde12');
  });

  it('没有记录时返回 null，不抛', async () => {
    const db = await freshDb();
    expect(db.getExternalSession('g1', 'm1')).toBeNull();
  });

  it('同一 (群, 成员) 重复写是更新，不是堆两行', async () => {
    const db = await freshDb();
    seedGroup(db);
    db.setExternalSession('g1', 'm1', 'uuid-1');
    db.setExternalSession('g1', 'm1', 'uuid-2');
    expect(db.getExternalSession('g1', 'm1')).toBe('uuid-2');
    expect(db.countExternalSessions()).toBe(1);
  });

  it('不同成员、不同群互不串', async () => {
    const db = await freshDb();
    seedGroup(db, 'g1');
    seedGroup(db, 'g2');
    db.setExternalSession('g1', 'm1', 'a');
    db.setExternalSession('g1', 'm2', 'b');
    db.setExternalSession('g2', 'm1', 'c');

    expect(db.getExternalSession('g1', 'm1')).toBe('a');
    expect(db.getExternalSession('g1', 'm2')).toBe('b');
    expect(db.getExternalSession('g2', 'm1')).toBe('c');
  });

  it('可以显式清掉——用户「重开一轮」时要能丢掉旧上下文', async () => {
    const db = await freshDb();
    seedGroup(db);
    db.setExternalSession('g1', 'm1', 'a');
    db.clearExternalSession('g1', 'm1');
    expect(db.getExternalSession('g1', 'm1')).toBeNull();
  });
});

describe('级联删除（这个库的删除是手写的，最容易漏）', () => {
  it('删群时外部会话一起删，不留孤儿', async () => {
    const db = await freshDb();
    seedGroup(db);
    db.setExternalSession('g1', 'm1', 'a');
    db.setExternalSession('g1', 'm2', 'b');

    db.deleteGroupChat('g1');

    expect(db.countExternalSessions(), '删群留下了孤儿会话行').toBe(0);
  });

  it('整批替换成员时，旧成员的会话一起删', async () => {
    const db = await freshDb();
    seedGroup(db);
    db.setExternalSession('g1', 'm1', 'a');

    db.deleteGroupMembers('g1');

    expect(db.countExternalSessions(), '换成员留下了孤儿会话行').toBe(0);
  });

  it('删一个群不影响另一个群的会话', async () => {
    const db = await freshDb();
    seedGroup(db, 'g1');
    seedGroup(db, 'g2');
    db.setExternalSession('g1', 'm1', 'a');
    db.setExternalSession('g2', 'm1', 'b');

    db.deleteGroupChat('g1');

    expect(db.getExternalSession('g2', 'm1')).toBe('b');
    expect(db.countExternalSessions()).toBe(1);
  });
});

describe('迁移', () => {
  it('在同一个库上反复构造不报错（迁移必须幂等）', async () => {
    const db = await freshDb();
    seedGroup(db);
    db.setExternalSession('g1', 'm1', 'a');

    // 模拟进程重启：同一个文件再打开一次
    const mod = await import('../src/db');
    const again = new (mod.default as any)();
    expect(again.getExternalSession('g1', 'm1'), '重启后会话丢了，等于每轮都按冷起计价').toBe('a');
  });
});

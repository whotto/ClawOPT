/**
 * `PUT /api/groups/:id` 的成员更新 —— 两件事一起修。
 *
 * ## ① 缺写路径（AGENTS.md:75 的既有违规）
 *
 * `group_members.runtime` 与 `external_config` 是我在 v1.8 加的配置，但路由只映射
 * agentId / displayName / roleDescription / position——**没有任何界面入口能设置它们**，
 * 只能靠开发脚本。`AGENTS.md:75` 原文：「不要新增没有界面入口的用户配置」。
 *
 * ## ② 编辑群会把外部成员打回原形（数据丢失）
 *
 * 这条是写守卫时才发现的，比 ① 严重：路由的做法是
 * `deleteGroupMembers()` 再整批重插。而 `deleteGroupMembers` 带级联——
 * **连同该群的全部外部会话一起删**；成员行本身也没了，于是
 * `saveGroupMember` 里那个 `COALESCE(@runtime, group_members.runtime)` 的保护
 * 完全失效，重插时 runtime 落回默认的 'openclaw'。
 *
 * 后果：用户只是改了个群名或调了下成员顺序，**所有外部成员退回 OpenClaw、
 * 会话全丢**，下一轮按冷起计价（实测贵 8.2 倍）。没有任何报错。
 *
 * 修法是别再「删光重插」：按 agent_id 增量 upsert，只删真正被移除的成员
 * （连同它的会话，否则留孤儿行）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-gmu-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.CLAWOPT_DATA_DIR = '.clawopt-test';
  vi.resetModules();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  catch (err) { console.warn('[test] 清理失败：', err); }
});

async function seeded() {
  const mod = await import('../src/core/db/db');
  const db = new (mod.default as any)();
  db.saveGroupChat({ id: 'g1', name: '群', description: '', position: 0 });
  db.saveGroupMember({
    id: 'gm_g1_eng', group_id: 'g1', agent_id: 'eng', display_name: 'Eng',
    role_description: '', position: 0,
    runtime: 'claude-code', external_config: JSON.stringify({ workingDir: '/srv/app' }),
  });
  db.saveGroupMember({ id: 'gm_g1_main', group_id: 'g1', agent_id: 'main', display_name: '管家', role_description: '', position: 1 });
  db.setExternalSession('g1', 'gm_g1_eng', 'uuid-1');
  return db;
}

/**
 * 直接调**真实现**，不在用例里复制一份路由逻辑——
 * `sessions-config-rollback.test.ts` 的文件头警告过：单测一段复制出来的逻辑
 * 不能证明真实路由确实这样做了。路由只负责把请求体映射进来，由下面的接线守卫盯。
 */
const applyMembers = (db: any, groupId: string, members: any[]) =>
  db.replaceGroupMembers(groupId, members);

describe('编辑群不能把外部成员打回原形', () => {
  it('**只改显示名时，runtime 与外部配置都还在**', async () => {
    const db = await seeded();
    applyMembers(db, 'g1', [
      { agentId: 'eng', displayName: '改了个名' },
      { agentId: 'main', displayName: '管家' },
    ]);

    const eng = db.getGroupMembers('g1').find((m: any) => m.agent_id === 'eng');
    expect(eng.display_name).toBe('改了个名');
    expect(eng.runtime, '改个名把外部成员打回 OpenClaw 了').toBe('claude-code');
    expect(JSON.parse(eng.external_config).workingDir).toBe('/srv/app');
  });

  it('**外部会话不能因为一次编辑就全丢**——下一轮会按冷起计价，贵 8.2 倍', async () => {
    const db = await seeded();
    applyMembers(db, 'g1', [{ agentId: 'eng', displayName: 'Eng' }, { agentId: 'main', displayName: '管家' }]);
    expect(db.getResumableExternalSession('g1', 'gm_g1_eng'), '编辑群把会话删了').toBe('uuid-1');
  });

  it('能设置 runtime 与外部配置（此前只能读不能写）', async () => {
    const db = await seeded();
    applyMembers(db, 'g1', [
      { agentId: 'main', displayName: '管家', runtime: 'claude-code', externalConfig: JSON.stringify({ workingDir: '/srv/other' }) },
    ]);
    const main = db.getGroupMembers('g1').find((m: any) => m.agent_id === 'main');
    expect(main.runtime).toBe('claude-code');
    expect(JSON.parse(main.external_config).workingDir).toBe('/srv/other');
  });

  it('被移除的成员连同它的会话一起清掉，不留孤儿行', async () => {
    const db = await seeded();
    applyMembers(db, 'g1', [{ agentId: 'main', displayName: '管家' }]);

    expect(db.getGroupMembers('g1').map((m: any) => m.agent_id)).toEqual(['main']);
    expect(db.countExternalSessions(), '成员没了，会话行还在').toBe(0);
  });

  it('顺序调整不影响 runtime', async () => {
    const db = await seeded();
    applyMembers(db, 'g1', [{ agentId: 'main', displayName: '管家' }, { agentId: 'eng', displayName: 'Eng' }]);
    const eng = db.getGroupMembers('g1').find((m: any) => m.agent_id === 'eng');
    expect(eng.position).toBe(1);
    expect(eng.runtime).toBe('claude-code');
  });
});

describe('路由确实这么做了（接线守卫）', () => {
  // 群聊路由在 P0 拆分后住在 collab/rooms/room-routes.ts（拆分前在 index.ts）。
  const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'collab', 'rooms', 'room-routes.ts'), 'utf-8');
  const body = () => {
    const i = SRC.indexOf("app.put('/api/groups/:id', guardManageRoom, guardMemberAgents, (req, res) => {");
    expect(i, "找不到 PUT /api/groups/:id").toBeGreaterThan(0);
    return SRC.slice(i, i + 2600);
  };

  it('不再「删光重插」——那会连会话一起删掉', () => {
    expect(body(), 'deleteGroupMembers 会级联删除外部会话，编辑一次群全丢')
      .not.toContain('deleteGroupMembers');
  });

  it('runtime 与 externalConfig 真的从请求体里读了', () => {
    const b = body();
    expect(b).toContain('runtime');
    expect(b).toContain('externalConfig');
  });
});

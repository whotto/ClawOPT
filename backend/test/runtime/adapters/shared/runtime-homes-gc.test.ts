/**
 * 守卫：**每一个**编码类运行时的运行时 home 都由平台的 RuntimeHomes 发（带归属标记），因而都能被回收。
 *
 * 参考实现从不回收 `runs/<hash>` 目录；这里要保证的是「删会话 / 删成员 / 删群 / 成员换运行时 / 定期清扫」
 * 对七个运行时一视同仁。某个适配器要是自己拼路径（不经 `homes.ensureHome`），它的目录没有标记，
 * 回收永远删不到——磁盘只涨不跌，而且没有任何报错。
 *
 * 用真实文件系统（临时目录）：适配器真的往 home 里落盘，RuntimeHomes 真的按标记删。
 * 证明会红：把 `_shared/cli-adapter.ts` 里的 `deps.homes.ensureHome(...)` 换成 `runtimeHomePath(...)`（同一个路径、不写标记），
 * 七个运行时的「目录带标记、releaseOwner 删得掉」全红。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodingAgentAdapter } from '../../../../src/runtime/adapters/_shared/cli-adapter';
import { createNodeRuntimeFs } from '../../../../src/runtime/adapters/_shared/runtime-fs';
import { CODING_AGENT_DEFINITIONS } from '../../../../src/runtime/adapters/registry';
import { MARKER_FILE, RuntimeHomes, type RuntimeHomeOwner } from '../../../../src/runtime/manager/runtime-homes';
import { baseRequest, flushMicrotasks, harness, startRun } from '../_helpers/harness';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

async function runOnce(runtime: string, homes: RuntimeHomes, owner: RuntimeHomeOwner, userHome: string) {
  const definition = CODING_AGENT_DEFINITIONS.find((entry) => entry.descriptor.id === runtime)!;
  const h = harness();
  h.deps.fs = createNodeRuntimeFs();
  h.deps.homeDir = userHome;
  h.deps.homes = homes;
  const adapter = createCodingAgentAdapter(definition, h.deps);
  const run = startRun(adapter, baseRequest({ owner, instructions: 'ClawOPT 规则' }), { proxyMode: 'global' });
  const proc = await h.exec.next();
  run.abort.abort();
  proc.close(null, 'SIGINT');
  await run.done;
  await flushMicrotasks(5);
}

describe('运行时目录回收：七个编码类运行时', () => {
  for (const definition of CODING_AGENT_DEFINITIONS) {
    const runtime = definition.descriptor.id;
    it(`${runtime}：home 由平台发（带标记）；删成员、删会话、换运行时、定期清扫都删得到`, async () => {
      const root = tmp('kb-clawopt-homes-');
      const userHome = tmp('kb-clawopt-userhome-');
      const homes = new RuntimeHomes(root);
      const member: RuntimeHomeOwner = { kind: 'room-member', groupId: 'g1', memberId: `gm_g1_${runtime}`, agentId: runtime };
      const session: RuntimeHomeOwner = { kind: 'session', sessionId: `s-${runtime}` };

      await runOnce(runtime, homes, member, userHome);
      await runOnce(runtime, homes, session, userHome);

      const listed = homes.list().filter((home) => home.runtime === runtime);
      expect(listed.map((home) => home.owner.kind).sort(), `${runtime} 的 home 没经 homes.ensureHome（没有标记，回收删不到）`).toEqual(['room-member', 'session']);
      for (const home of listed) {
        expect(fs.existsSync(path.join(home.path, MARKER_FILE))).toBe(true);
        expect(home.path.startsWith(path.join(root, runtime))).toBe(true);
      }

      // 成员换了运行时：旧运行时下的目录回收，新运行时的留着。
      expect(homes.releaseOwner({ kind: 'room-member', groupId: 'g1', memberId: `gm_g1_${runtime}` }, { exceptRuntime: runtime })).toBe(0);
      expect(homes.releaseOwner({ kind: 'room-member', groupId: 'g1', memberId: `gm_g1_${runtime}` }, { exceptRuntime: 'some-other-runtime' })).toBe(1);
      expect(homes.list().some((home) => home.owner.kind === 'room-member')).toBe(false);

      // 会话被删（定期清扫看到归属已不在）。
      const removed = homes.sweep((owner) => !(owner.kind === 'session' && owner.sessionId === `s-${runtime}`));
      expect(removed.map((entry) => entry.reason)).toEqual(['orphaned']);
      expect(homes.list()).toEqual([]);
    });
  }

  it('成员还在但换了运行时：清扫按 (归属, 运行时) 判孤儿', async () => {
    const root = tmp('kb-clawopt-homes-');
    const homes = new RuntimeHomes(root);
    const owner: RuntimeHomeOwner = { kind: 'room-member', groupId: 'g2', memberId: 'gm_g2_a' };
    homes.ensureHome('codex', owner);
    homes.ensureHome('pi', owner);
    const removed = homes.sweep((_owner, runtime) => runtime === 'pi');
    expect(removed.map((entry) => entry.runtime)).toEqual(['codex']);
    expect(homes.list().map((home) => home.runtime)).toEqual(['pi']);
  });
});

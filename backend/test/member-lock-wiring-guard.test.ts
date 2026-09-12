/**
 * 成员锁的**机械守卫** —— 防的是 v1.2.5 那类事故。
 *
 * 那次：名册门面的代码发布了，而调用点仍在直接操作 `agents.list`，
 * 「守卫和被守卫的代码一起消失」，158 个用例全绿。所以这道守卫住在一个
 * **独立文件**里，只断言接线存在，不断言行为——行为由 group-lock.test.ts 管。
 *
 * 它顺带钉住一条容易被顺手改回去的约定：
 * **新消息不走群锁，重新生成走群锁**（v1.5.2 明确要求过后者）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'group-chat-engine.ts'), 'utf-8',
);

/** 取某个方法从声明到下一个同级方法之间的正文。 */
function methodBody(name: string): string {
  const start = SRC.indexOf(`  async ${name}(`) >= 0
    ? SRC.indexOf(`  async ${name}(`)
    : SRC.indexOf(`  public async ${name}(`);
  expect(start, `找不到方法 ${name}——它被改名或删掉了`).toBeGreaterThan(0);
  const rest = SRC.slice(start + 10);
  const end = rest.search(/\n  (?:public |private )?(?:async )?[a-zA-Z]\w*\(/);
  return rest.slice(0, end > 0 ? end : rest.length);
}

describe('成员锁必须真的接在派发路径上', () => {
  it('sendToAgent 取锁', () => {
    expect(methodBody('sendToAgent'), 'sendToAgent 没有取成员锁，锁就是死代码')
      .toContain('acquireMemberLock');
  });

  it('sendToAgent 在 finally 里放锁——不能在某个 return 出口放', () => {
    const body = methodBody('sendToAgent');
    expect(body).toContain('releaseMemberLock');
    // 中途抛错、被 /stop 打断、上游超时都会跳过普通出口；
    // 锁漏放一次，那个成员就要等 15 分钟陈旧接管才能再说话。
    const finallyIndex = body.lastIndexOf('} finally {');
    expect(finallyIndex, 'sendToAgent 没有 finally 块').toBeGreaterThan(0);
    // 现在有两处释放（外部分支一处、网关路径一处），所以断言**最后一处**在
    // 最后一个 finally 里——那是网关路径的出口。外部分支自己那处由下面的
    // 「外部分支自己释放成员锁」单独守。
    expect(
      body.lastIndexOf('releaseMemberLock') > finallyIndex,
      'releaseMemberLock 不在 finally 里——异常路径会漏放锁',
    ).toBe(true);
  });

  it('新消息**不**握整轮群锁（否则成员锁永远不会竞争）', () => {
    expect(
      methodBody('sendUserMessage'),
      '群锁又回到新消息路径上了——一个成员跑 10 分钟又会锁住整个群',
    ).not.toContain('processingGroups.add');
  });

  it('重新生成**仍然**走群锁（v1.5.2 的明确要求）', () => {
    expect(
      methodBody('rerunUserMessage'),
      '重新生成丢了群锁：它重写的是已有消息的分支，并发改同一条链会互相覆盖',
    ).toContain('processingGroups.add');
  });

  it('「群忙不忙」把成员锁算进去', () => {
    expect(SRC, 'isGroupBusy 没算成员锁，界面会显示成空闲').toContain('hasBusyMember');
  });
});

describe('外部成员必须真的被路由过去', () => {
  it('sendToAgent 按 member.runtime 分岔', () => {
    const body = methodBody('sendToAgent');
    expect(body, '外部成员仍然走网关路径——runtime 字段等于没接')
      .toContain('runExternalMember');
    expect(body).toContain("member.runtime");
  });

  it('外部分支自己释放成员锁（它提前 return，走不到下面那个 finally）', () => {
    const body = methodBody('sendToAgent');
    const branch = body.slice(body.indexOf('runExternalMember'));
    const head = branch.slice(0, 400);
    expect(head, '外部分支 return 之后没放锁，那个成员要等 15 分钟陈旧接管')
      .toContain('releaseMemberLock');
    // 而且要在它自己的 finally 里：外部执行器抛错时同样得放锁。
    expect(
      head.indexOf('} finally {') >= 0 && head.indexOf('} finally {') < head.indexOf('releaseMemberLock'),
      '外部分支的释放不在 finally 里——执行器抛错就会漏放锁',
    ).toBe(true);
  });

  it('外部路径不复用网关那条流程（两条路要分开）', () => {
    // runExternalMember 里若出现网关客户端，说明两条路又缠在一起了。
    const src = SRC.slice(SRC.indexOf('private async runExternalMember'));
    const body = src.slice(0, src.indexOf('\n  public async sendToAgent('));
    expect(body).not.toContain('OpenClawClient');
    expect(body).not.toContain('subscribeSessionEvents');
  });
});


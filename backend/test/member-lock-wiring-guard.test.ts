/**
 * 成员锁的**机械守卫** —— 防的是 v1.2.5 那类事故。
 *
 * 那次：名册门面的代码发布了，而调用点仍在直接操作 `agents.list`，
 * 「守卫和被守卫的代码一起消失」，158 个用例全绿。所以这道守卫住在一个
 * **独立文件**里，只断言接线存在，不断言行为——行为由 group-lock.test.ts 管。
 *
 * P3 起执行一跳的入口是 `executeTurn`（编排器的每 Agent 队列调用它），转交路由不在引擎里；
 * 它顺带钉住：新消息永远受理（不按「群里有人在跑」409），重新生成 / 编辑重跑按「目标在跑或在排队」409。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'collab', 'rooms', 'group-chat-engine.ts'), 'utf-8',
);

/** 取某个方法从声明到下一个同级方法之间的正文。 */
function methodBody(name: string): string {
  const candidates = [`  async ${name}(`, `  public async ${name}(`, `  private async ${name}(`];
  const start = candidates.map((candidate) => SRC.indexOf(candidate)).find((index) => index >= 0) ?? -1;
  expect(start, `找不到方法 ${name}——它被改名或删掉了`).toBeGreaterThan(0);
  const rest = SRC.slice(start + 10);
  const end = rest.search(/\n  (?:public |private )?(?:async )?[a-zA-Z]\w*\(/);
  return rest.slice(0, end > 0 ? end : rest.length);
}

describe('成员锁必须真的接在派发路径上', () => {
  it('executeTurn 取锁', () => {
    expect(methodBody('executeTurn'), 'executeTurn 没有取成员锁，锁就是死代码').toContain('acquireMemberLock');
  });

  it('executeTurn 在最外层 finally 里放锁——不能在某个 return 出口放', () => {
    const body = methodBody('executeTurn');
    const finallyIndex = body.lastIndexOf('} finally {');
    expect(finallyIndex, 'executeTurn 没有 finally 块').toBeGreaterThan(0);
    expect(body.lastIndexOf('releaseMemberLock') > finallyIndex, 'releaseMemberLock 不在 finally 里——异常路径会漏放锁').toBe(true);
    // 外部分支与网关分支都在同一个 try 里 return：锁只在一处放。
    expect(body.split('releaseMemberLock').length - 1).toBe(1);
  });

  it('「群忙不忙」把成员锁算进去', () => {
    expect(SRC, 'isGroupBusy 没算成员锁，界面会显示成空闲').toContain('hasBusyMember');
  });

  it('引擎不再递归转交：转交路由只在编排器里', () => {
    expect(SRC).not.toContain('sendToAgent');
    expect(SRC).not.toContain('parseMentions(');
  });
});

describe('外部成员必须真的被路由过去', () => {
  it('executeTurn 按 member.runtime 分岔', () => {
    const body = methodBody('executeTurn');
    expect(body, '外部成员仍然走网关路径——runtime 字段等于没接').toContain('runExternalMember');
    expect(body).toContain('member.runtime');
  });

  it('外部路径不复用网关那条流程（两条路要分开）', () => {
    const body = methodBody('runExternalMember');
    expect(body).not.toContain('OpenClawClient');
    expect(body).not.toContain('subscribeSessionEvents');
  });

  it('外部分支经运行协调器提交，不再自己直接调执行器（P1a）', () => {
    const body = methodBody('runExternalMember');
    expect(body, '外部成员绕过了协调器：陈旧检查、中止、用量去重、工具调用落库全部失效').toContain('coordinator.submit(');
    expect(body, '执行器又被直接调用了——它应当只作为适配器的注入项').not.toMatch(/spawn\(|await runner\(|executor\(/);
    expect(body).toContain('this.runtimeAdapters?.(runtime)');
  });

  it('群聊停止也中止协调器里的外部成员运行（否则停止按钮停不住外部 Agent）', () => {
    const routes = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'collab', 'rooms', 'room-routes.ts'), 'utf-8');
    const stop = routes.slice(routes.indexOf("app.post('/api/groups/:id/stop'"));
    expect(stop.slice(0, 1600)).toContain('runCoordinator.abortTopic(roomTopic(req.params.id)');
  });
});

// 群聊路由在 P0 拆分后住在 collab/rooms/room-routes.ts（拆分前在 index.ts）。
const ROUTES_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'collab', 'rooms', 'room-routes.ts'), 'utf-8',
);

/** 取某条路由声明之后的一段正文。 */
function routeBody(declaration: string, span = 1600): string {
  const start = ROUTES_SRC.indexOf(declaration);
  expect(start, `找不到路由 ${declaration}——它被改名或删掉了`).toBeGreaterThan(0);
  return ROUTES_SRC.slice(start, start + span);
}

describe('新消息与重新生成用的不是同一个判据（P3）', () => {
  it('发新消息进编排器排队，不按群忙 409', () => {
    const body = routeBody("app.post('/api/groups/:id/messages', guardRoom, async (req, res) => {");
    expect(body).toContain('orchestrator.ingestHumanMessage');
    expect(body).not.toContain('isGroupProcessing(');
    expect(body).not.toContain('GROUP_RUN_IN_PROGRESS_ERROR_CODE');
  });

  it('重新生成看「这个 Agent 在跑或在排队」', () => {
    const body = routeBody("app.post('/api/groups/:id/messages/regenerate', guardRoom, async (req, res) => {", 2600);
    expect(body, '重新生成没查目标在跑：旧运行会往已删除的消息 id 写 delta，前端复活幽灵消息').toContain('isMemberBusy(');
    expect(body).toContain('pendingCount(');
  });

  it('编辑后重跑看「群里有人在跑或在排队」（它会删掉之后的消息）', () => {
    const body = routeBody("app.put('/api/groups/:id/messages/:msgId', guardRoom, (req, res) => {", 2000);
    expect(body).toContain('isGroupProcessing(');
    expect(body).toContain('busyMembers(');
  });
});

/**
 * `POST /api/sessions` 在配置读不动时不再留下孤儿 session（评审 Codex 复核）。
 *
 * 背景：路由处理器原来是先 `sessionManager.createSession()` 再
 * `agentProvisioner.provision()`——`provision()` 内部读 `openclaw.json` 抛出
 * `ConfigReadError` 时，session 行已经写进库了，但 catch 块只把错误转成
 * 400 响应，从不回滚。用户看到失败提示，去把配置修好，用同一个 agent ID 重试，
 * 却被 `AGENT_ID_ALREADY_EXISTS_ERROR_CODE` 挡住——这个 ID 已经"存在"了，
 * 永远重试不了同一个 ID，只能改个新 ID，界面上就会留下一个永远半成品的会话。
 *
 * 这批用例通过真实启动一份后端进程（而不是绕开路由直接调用底层函数）来验证：
 * 1. 配置损坏时 POST /api/sessions 失败，且失败原因能在 errorCode 上分辨出
 *    "配置读不动"而不是被塞进笼统的 `models.updateFailed`。
 * 2. 失败之后，同一个 agent ID 不会被锁死——把配置修好，用同一个 ID 重试会成功，
 *    证明上面创建的孤儿 session 行确实被回滚掉了。
 *
 * 这里选择整进程集成测试（而不是抽取路由逻辑单测）是因为本仓库里
 * `src/index.ts` 的路由处理器本身就是这个回滚要修的代码——单测一段复制出来的
 * 逻辑不能证明真实路由确实这样做了。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * 端口由内核分配，**不是**固定值。
 *
 * 原来是 `9931 + VITEST_WORKER_ID`，叠加下面 `afterAll` 的进程收敛问题，
 * 会产生一个**间歇性的假失败**：上一次运行残留的服务器还占着同一个端口，
 * 本次探针连上它就以为自己起来了，而那台服务器的库里已经有
 * `rollback-test-agent`——于是「修好配置后用同一个 ID 重试会成功」这条断言
 * 收到 400 `AGENT_ID_ALREADY_EXISTS`。评审实测 8 次里红 2 次，单跑该文件 5 次全绿。
 *
 * 这个失败最坏的地方在于它**不指向真实原因**：报错说的是回滚没生效，
 * 而回滚代码是好的。与 `AGENTS.md` 记的「两处判据分家」是同一类事故。
 *
 * 修法选了「让碰撞不可能发生」而不是「碰撞后校验身份」：
 * 事后校验还得设计一个身份令牌，而为测试往生产代码加探针路由，
 * 等于留下一个没人维护的攻击面。
 */
let PORT: number;
let BASE_URL: string;

/** 向内核要一个当前空闲的端口。listen(0) 后立刻读回真实端口再关掉。 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error('拿不到内核分配的端口')));
      }
    });
  });
}


let tmpHome: string;
let configPath: string;
let child: ChildProcess;
let childOutput = '';

/**
 * 等到本次这台服务器起来为止。
 *
 * 端口是内核刚分配的空闲端口，所以「这个端口上有人应答」现在**等价于**
 * 「应答的是我刚起的那个进程」——不再需要事后猜身份。
 * 另外盯一眼子进程的输出：`EADDRINUSE` 或进程提前退出时立刻失败并说清原因，
 * 而不是干等 60 秒再报一句没有信息量的超时。
 */
async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `后端进程在起来之前就退出了（code=${child.exitCode} signal=${child.signalCode}）。` +
          `最后输出：\n${childOutput.slice(-2000)}`,
      );
    }
    if (/EADDRINUSE/.test(childOutput)) {
      throw new Error(`端口 ${PORT} 被占用——内核刚分配的端口被抢了，这不该发生：\n${childOutput.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/api/sessions`);
      if (res.ok) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`后端进程在 ${timeoutMs}ms 内没有起来。最后输出：\n${childOutput.slice(-2000)}`);
}

/**
 * 杀掉整个进程组并**等它真的退出**，而不是发完信号就返回。
 *
 * 两件事的证据强度不一样，分开说：
 *
 * **已验证**：原来的 `afterAll` 是同步的 `child.kill()`，发完信号立刻返回。
 * 下一个测试文件可能在旧服务器还没关完时就开始跑。改成 `await` 退出事件之后，
 * 本文件连跑 3 次全绿、零残留。
 *
 * **未验证**：评审报告称 `child.kill()` 只 SIGTERM 了 `npx` 包装进程、
 * 孙进程 `ts-node` 会活下来占端口。**本机（darwin, Node v24.19.0）复现不出来**：
 * 把 `detached` 与进程组 kill 去掉后重跑，残留 `ts-node` 进程数仍是 0——
 * 这台机器上的 `npx` 大概是 exec 而不是 fork，`ts-node` 就是直接子进程。
 * 进程组 kill 在这里属于**防御性**写法（对 npx 确实 fork 的平台有效），
 * 不是一条被实证过的修复。如实记在这里，不冒充成已验证。
 *
 * 真正让端口碰撞不可能发生的是上面的动态端口，不是这一段。
 */
async function terminateServer(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    // 负号 = 整个进程组。见上面「未验证」那段：防御性，不是实证修复。
    process.kill(-(child.pid as number), 'SIGTERM');
  } catch (err) {
    console.warn('[test] 向进程组发 SIGTERM 失败，退回单进程 kill：', err);
    child.kill('SIGTERM');
  }

  // 宽限期内没退就升级到 KILL——一个卡住的子进程会一直占着资源。
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ]);
  if (!killed) {
    // 这里原来是 `catch { /* 已经没了 */ }`。注释声称的范围（进程已不存在）
    // 代码从来没有校验过：`ESRCH`（真的没了）与 `EPERM`（还活着但杀不动）
    // 被同样吞掉，而 `EPERM` 时紧接着的 `await exited` 会**永久等待**——
    // 一个自称"清理"的 catch 把用例挂死，且没有任何输出指向这里。
    // 本仓库对"带注释说明范围"的 catch 的豁免，要求注释**真的界定了失败面**，
    // 不是声称界定了。同一次提交给另外两处清理型 catch 补了 warn，判法却不一致。
    let alreadyGone = false;
    try {
      process.kill(-(child.pid as number), 'SIGKILL');
    } catch (err) {
      alreadyGone = (err as NodeJS.ErrnoException)?.code === 'ESRCH';
      if (!alreadyGone) {
        console.warn('[test] SIGKILL 进程组失败，不再等待它退出：', err);
      }
    }
    if (alreadyGone) return;
    // 即使 KILL 发出去了也不无限等：等不到就出声返回，让后续用例继续跑，
    // 而不是把整个测试文件挂在这一行上。
    const reaped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!reaped) {
      console.warn(`[test] 子进程 ${child.pid} 在 SIGKILL 后仍未退出，放弃等待（可能残留进程）`);
    }
  }
}

beforeAll(async () => {
  PORT = await reserveFreePort();
  BASE_URL = `http://127.0.0.1:${PORT}`;
  childOutput = '';
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-sess-rollback-'));
  const openclawDir = path.join(tmpHome, '.openclaw');
  fs.mkdirSync(openclawDir, { recursive: true });
  configPath = path.join(openclawDir, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({ agents: { list: [] } }));

  child = spawn('npx', ['ts-node', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: tmpHome, PORT: String(PORT) },
    stdio: 'pipe',
    // 自成进程组，`terminateServer()` 才能用 `process.kill(-pid)` 一次收走
    // `npx` 与它派生的 `ts-node`。只 kill 直接子进程会留孙进程占着端口。
    detached: true,
  });

  child.stdout?.on('data', (b) => { childOutput += String(b); });
  child.stderr?.on('data', (b) => { childOutput += String(b); });

  await waitForServer(60_000);
}, 70_000);

afterAll(async () => {
  await terminateServer();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch (err) {
    // 清理失败本身不该让用例红，但也不该没人知道——临时目录堆积会慢慢吃满磁盘。
    console.warn('[test] 清理临时 HOME 失败：', err);
  }
});

describe('POST /api/sessions：配置读不动时回滚孤儿 session（S1 iter3 修复）', () => {
  // 原来这里有一条自称"红证"的用例：拿一个本来就存在的 session ID 去 POST，
  // 断言它被 AGENT_ID_ALREADY_EXISTS 挡住。这件事在"不回滚"的旧代码下和
  // "回滚"的新代码下结果完全一样——它从来没有创建过、也没有观察过孤儿 session，
  // 无论回滚逻辑存在与否都恒为真，对本 sprint 要修的回归零红证价值（评审
  // Codex/Gemini 复核，红线 B）。已删除；下面两条用例才是真正验证"孤儿 session
  // 被回滚掉"这条因果链的地方（先制造孤儿、再用同一个 ID 验证它已经不存在）。

  it('配置损坏时创建 session 失败，errorCode 是 agents.configReadFailed，不是笼统的 models.updateFailed', async () => {
    const goodConfig = fs.readFileSync(configPath, 'utf-8');
    fs.writeFileSync(configPath, '{ "agents": '); // 截断，模拟配置损坏

    try {
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'rollback-test-agent', name: 'RollbackTest' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('agents.configReadFailed');
      expect(body.errorCode).not.toBe('models.updateFailed');
    } finally {
      fs.writeFileSync(configPath, goodConfig);
    }
  });

  it('修好配置后，用同一个 agent ID 重试会成功——证明上面失败时创建的孤儿 session 被回滚掉了', async () => {
    // 沿用上一条用例失败时使用的同一个 ID：如果它没被回滚，这里会被
    // AGENT_ID_ALREADY_EXISTS_ERROR_CODE 挡住，而不是真正走到 provision。
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'rollback-test-agent', name: 'RollbackTest' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.session.id).toBe('rollback-test-agent');
  });
});

/**
 * 只读展示型接口在配置读不动时优雅降级，不再整体 500（Adversarial/Codex 复核，
 * sprint1-iter4）。
 *
 * 背景：iter3 把 `readAgentModel()` 改成对 `ConfigReadError` 往上抛，但
 * `GET /api/sessions`、`GET /api/characters`、`GET /api/sessions/:id/configs`、
 * `GET /api/models` 这四个纯只读接口原来没有任何 try/catch 包住它们对
 * `readAgentModel()` / `readAgentModelConfig()` / `readAvailableModels()` /
 * `readEffectiveAgentRuntimeSettings()` 的调用——配置一损坏，这四个首屏必调的
 * 接口就从"优雅降级"整体变成"裸 500"，比本 sprint 要修的 bug 更糟：旧代码
 * （sprint 起点）在同样损坏的配置下至少能返回 200，只是 model 字段是空字符串。
 *
 * 这里用真实进程 + 真实损坏配置逐一验证：四个接口都不再 500，且各自在响应里
 * 带上 `configReadFailed` 让前端能分辨"这不是没配模型，是配置读不动"。
 */
describe('只读接口在配置读不动时不再整体 500（S1 iter4 修复）', () => {
  it('配置截断时，GET /api/sessions 仍返回 200，且每一行带 configReadFailed: true', async () => {
    const goodConfig = fs.readFileSync(configPath, 'utf-8');
    fs.writeFileSync(configPath, '{ "agents": ');
    try {
      const res = await fetch(`${BASE_URL}/api/sessions`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0].model).toBe('');
      expect(body[0].configReadFailed).toBe(true);
    } finally {
      fs.writeFileSync(configPath, goodConfig);
    }
  });

  it('配置截断时，GET /api/characters 仍返回 200，且带顶层 configReadFailed: true', async () => {
    const goodConfig = fs.readFileSync(configPath, 'utf-8');
    fs.writeFileSync(configPath, '{ "agents": ');
    try {
      const res = await fetch(`${BASE_URL}/api/characters`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.configReadFailed).toBe(true);
    } finally {
      fs.writeFileSync(configPath, goodConfig);
    }
  });

  it('配置截断时，GET /api/models 仍返回 200，退回空列表并带 configReadFailed: true', async () => {
    const goodConfig = fs.readFileSync(configPath, 'utf-8');
    fs.writeFileSync(configPath, '{ "agents": ');
    try {
      const res = await fetch(`${BASE_URL}/api/models`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toEqual([]);
      expect(body.configReadFailed).toBe(true);
    } finally {
      fs.writeFileSync(configPath, goodConfig);
    }
  });

  it('配置截断时，GET /api/sessions/:id/configs 仍返回 200，其余六份 markdown 字段依然可读', async () => {
    const goodConfig = fs.readFileSync(configPath, 'utf-8');
    const listRes = await fetch(`${BASE_URL}/api/sessions`);
    const sessions = await listRes.json();
    const sessionId = sessions[0].id;

    fs.writeFileSync(configPath, '{ "agents": ');
    try {
      const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/configs`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.configs.configReadFailed).toBe(true);
      expect(body.configs.model).toBeNull();
      expect(typeof body.configs.soulContent).toBe('string');
    } finally {
      fs.writeFileSync(configPath, goodConfig);
    }
  });
});

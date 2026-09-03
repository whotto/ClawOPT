/**
 * `readConfigFile()` 的三态化，以及 `provision()` 在配置读不动时不再装成功 —— S1-A1。
 *
 * 背景：`readConfigFile()` 原来把「`openclaw.json` 不存在」和「文件在但解析失败」
 * 都塌成同一个 `null`。上游 `updateConfigList()` 写的是 `if (!config) return false`，
 * 而 `provision()` 直接把这个 false 当返回值交回——装配报「没有变化」，
 * Agent 从未真正写进 `openclaw.json`，界面却不会报错。
 *
 * 这里验三件事：
 * 1. 文件不存在仍然是合法状态（`readConfigFile()` 返回 null，不抛）——反向断言，
 *    防止「一律抛错」这种更简单但错误的修法蒙混过关。
 * 2. 文件存在但读不动的三种情形——JSON 截断、带注释的 JSON5、chmod 000 不可读——
 *    互相之间的失败原因不同，不会塌成同一个 reason。
 * 3. 从 `provision()` 这个真实调用入口断言：配置读不动时它不再返回一个
 *    代表成功的值，而是抛出可分辨原因的错误。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let prevHome: string | undefined;
let openclawDir: string;
let configPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-cfg-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  openclawDir = path.join(tmpHome, '.openclaw');
  fs.mkdirSync(openclawDir, { recursive: true });
  configPath = path.join(openclawDir, 'openclaw.json');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  // chmod 000 的文件在有些平台上 rmSync 需要先改权限才能删
  try {
    fs.chmodSync(configPath, 0o644);
  } catch (err) {
    // 文件可能压根没建（多数用例不走 chmod 000 那条），这里失败是正常的。
    // 仍然出声：同一条红线在同一个仓库里不该有两种判法——db-foreign-keys.test.ts
    // 里的同型写法已经改成出声了。
    console.warn('[test] 恢复配置文件权限失败（多数情况下是文件不存在）：', err);
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** 每个用例都要一个干净的 AgentProvisioner 实例，构造时会读一次配置来修补模型能力表。 */
async function freshProvisioner() {
  const mod = await import('../src/agent-provisioner');
  return { AgentProvisioner: mod.AgentProvisioner, ConfigReadError: mod.ConfigReadError };
}

describe('readConfigFile() 三态化（S1-A1-a/b/c）', () => {
  it('openclaw.json 不存在时返回 null，不抛错——这是合法状态，不是失败', async () => {
    const { AgentProvisioner } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();
    expect(() => provisioner.readConfigFile()).not.toThrow();
    expect(provisioner.readConfigFile()).toBeNull();
  });

  it('内容是截断的 JSON 时抛出 ConfigReadError，reason 是 parseError', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();
    try {
      provisioner.readConfigFile();
      expect.unreachable('应该抛出 ConfigReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigReadError);
      expect((error as InstanceType<typeof ConfigReadError>).reason).toBe('parseError');
    }
  });

  it('内容带 // 注释（JSON5 方言）时 reason 是 jsonWithComments，不是笼统的 parseError', async () => {
    fs.writeFileSync(configPath, '{\n  // 这是注释，标准 JSON 不支持\n  "agents": {}\n}');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();
    try {
      provisioner.readConfigFile();
      expect.unreachable('应该抛出 ConfigReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigReadError);
      expect((error as InstanceType<typeof ConfigReadError>).reason).toBe('jsonWithComments');
    }
  });

  it('文件 chmod 000 不可读时 reason 是 unreadable，且与另两种失败原因不同', async () => {
    if (process.getuid && process.getuid() === 0) {
      // root 会无视权限位，这条用例在 root 下没有意义，跳过而不是假装通过
      return;
    }
    fs.writeFileSync(configPath, '{}');
    fs.chmodSync(configPath, 0o000);
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();
    try {
      provisioner.readConfigFile();
      expect.unreachable('应该抛出 ConfigReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigReadError);
      const reason = (error as InstanceType<typeof ConfigReadError>).reason;
      expect(reason).toBe('unreadable');
      expect(reason).not.toBe('parseError');
      expect(reason).not.toBe('jsonWithComments');
    }
  });
});

describe('provision() 在配置读不动时不再返回代表成功的值（S1-A1-d）', () => {
  it('openclaw.json 截断时，provision() 直接抛错，而不是 resolve 出一个 false/undefined 假装"处理过了"', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    await expect(
      provisioner.provision({ agentId: 'test-agent-config-broken' }),
    ).rejects.toThrow();
  });

  it('对照组：openclaw.json 是合法空配置时，provision() 正常返回并把 agent 写进 agents.list', async () => {
    fs.writeFileSync(configPath, '{}');
    const { AgentProvisioner } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    const result = await provisioner.provision({ agentId: 'test-agent-config-ok' });
    expect(result).toBe(true);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const written_ids = (written.agents?.list || []).map((e: any) => e.id);
    expect(written_ids).toContain('test-agent-config-ok');
  });
});

/**
 * 三个读接口不再把 ConfigReadError 吞成"看起来正常的空结果"（评审 CRITICAL 复核）。
 *
 * `readConfigFile()` 三态化之后，`readAgentModel()` / `readAvailableModels()` /
 * `getEndpoints()` 原来的裸 catch 会把新抛出的 ConfigReadError 一并吞掉，
 * 分别塌成 `null` / `[]` / `[]`——界面看到的是"这个 Agent 没配模型""没有可用模型"
 * "没有端点"，跟"配置真的是空的"这个合法状态**长得一模一样**，用户分不出配置
 * 是坏的还是本来就没配。这批用例断言：配置读不动时，这三个函数改成往上抛，
 * 而不是继续假装成一个空结果。
 */
describe('读接口不再把「配置读不动」伪装成「没有数据」', () => {
  it('readAgentModel() 遇到损坏配置时抛出 ConfigReadError，不是悄悄返回 null', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.readAgentModel('main')).toThrow(ConfigReadError);
  });

  it('readAvailableModels() 遇到损坏配置时抛出 ConfigReadError，不是悄悄返回 []', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.readAvailableModels()).toThrow(ConfigReadError);
  });

  it('getEndpoints() 遇到损坏配置时抛出 ConfigReadError，不是悄悄返回 []', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.getEndpoints()).toThrow(ConfigReadError);
  });

  it('对照组：openclaw.json 不存在（合法状态）时，三个函数仍然安静地返回空结果，不抛错', async () => {
    // 不写 configPath——文件不存在是合法状态，不该被这次修复误伤成"抛错"。
    const { AgentProvisioner } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.readAgentModel('main')).not.toThrow();
    expect(provisioner.readAgentModel('main')).toBeNull();
    expect(() => provisioner.readAvailableModels()).not.toThrow();
    expect(provisioner.readAvailableModels()).toEqual([]);
    expect(() => provisioner.getEndpoints()).not.toThrow();
    expect(provisioner.getEndpoints()).toEqual([]);
  });
});

/**
 * 非 provision() 入口也会看到 ConfigReadError——这是有意的（评审 CRITICAL 复核）。
 *
 * `readConfigFile()` 三态化之前，它对任何读不动的情形都返回 `null`，从没抛过错；
 * `readAgentRuntimeConfig()` / `readAgentModelConfig()` 内部直接用它的返回值，
 * 自己完全没有 try/catch。三态化之后，这两个函数第一次会把 ConfigReadError
 * 原样往外抛——这是三态化本身的直接后果，不是这批用例引入的新改动，但此前没有
 * 任何用例断言过这件事是"有意如此"而不是意外的副作用。这里补上：确认这两个
 * 常被群聊运行时、会话列表调用的读取入口，在配置损坏时也会让失败可见，
 * 而不是被上一层未知的调用方悄悄吞掉。
 */
describe('非 provision() 的读取入口在配置损坏时也会让失败可见（不是意外的副作用）', () => {
  it('readAgentRuntimeConfig() 在配置损坏时抛出 ConfigReadError，不是回退到默认运行时设置', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.readAgentRuntimeConfig('main')).toThrow(ConfigReadError);
  });

  it('readAgentModelConfig() 在配置损坏时抛出 ConfigReadError，不是回退到"没配模型"', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.readAgentModelConfig('main')).toThrow(ConfigReadError);
  });

  it('对照组：配置文件不存在（合法状态）时，两个入口都正常返回默认值，不抛错', async () => {
    const { AgentProvisioner } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.readAgentRuntimeConfig('main')).not.toThrow();
    expect(() => provisioner.readAgentModelConfig('main')).not.toThrow();
    expect(provisioner.readAgentModelConfig('main').resolvedModel).toBeNull();
  });
});

/**
 * `ensureMainAgent()` 在启动期读不动配置时不再拖垮整个进程（评审 Adversarial 复核）。
 *
 * 背景：`ensureMainAgent()` 在三态化之前一直是自己 `JSON.parse(fs.readFileSync(...))`，
 * 完全绕开了本 sprint 加的 `readConfigFile()`/`ConfigReadError`。它在 `index.ts` 里是
 * `server.listen()` 之前的顶层同步调用——`openclaw.json` 截断时，未捕获的 SyntaxError
 * 会在端口监听之前就把整个后端进程炸掉，比运行期任何一个"读不动"都更糟：这时候
 * 连 `/api/characters` 那种已经优雅降级的接口都发不出请求，因为进程根本没起来。
 *
 * 这里验证：`ensureMainAgent()` 改用 `readConfigFile()` 之后，同样的损坏配置不再
 * 让它抛出未分类的 SyntaxError，而是识别成 `ConfigReadError` 并优雅地返回 false。
 */
describe('ensureMainAgent() 在配置读不动时优雅降级，不再让启动期崩溃（Adversarial 复核）', () => {
  // 原来这里有一条自称"红证"的用例，只断言 `JSON.parse('{ "agents": ')` 会抛
  // SyntaxError——这是 V8 内置行为，不碰 ensureMainAgent() 一行代码，无论
  // ensureMainAgent() 怎么改它永远绿，对这道新守卫零红证价值（评审 Codex/Gemini
  // 复核，红线 B）。真正的红证记在 sprint1-iter4 的 generator report 里：把
  // ensureMainAgent() 改回 `JSON.parse(fs.readFileSync(configPath, 'utf-8'))`
  // 直接读文件，下面这条用例会失败（抛出未分类的 SyntaxError 而不是返回
  // false），还原后变绿。

  it('openclaw.json 截断时，ensureMainAgent() 不抛错，返回 false（进程能继续跑到 listen）', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(() => provisioner.ensureMainAgent()).not.toThrow();
    expect(provisioner.ensureMainAgent()).toBe(false);
  });

  it('openclaw.json 带 chmod 000 权限损坏时，ensureMainAgent() 同样不抛错', () => {
    if (process.getuid && process.getuid() === 0) return; // root 无视权限位，跳过
    fs.writeFileSync(configPath, '{}');
    fs.chmodSync(configPath, 0o000);
    return (async () => {
      const { AgentProvisioner } = await freshProvisioner();
      const provisioner: any = new AgentProvisioner();
      expect(() => provisioner.ensureMainAgent()).not.toThrow();
      expect(provisioner.ensureMainAgent()).toBe(false);
    })();
  });

  it('对照组：合法空配置时，ensureMainAgent() 正常把 main agent 写进 agents.list 并返回 true', async () => {
    fs.writeFileSync(configPath, '{}');
    const { AgentProvisioner } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    expect(provisioner.ensureMainAgent()).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect((written.agents.list || []).some((a: any) => a.id === 'main')).toBe(true);
  });
});

/**
 * 对抗测试实证补漏：`JSON.parse` **成功**但结果不是对象的情形（Sprint 1 收尾）。
 *
 * 上面那批用例只覆盖了「`JSON.parse` 抛异常」。而 `null` / `false` / `0` / `[]`
 * 全都 **parse 成功**——本 sprint 声称修好的那类失败于是原样复现：
 * 对抗测试实测把 `null` 写进 openclaw.json 后建 Agent，接口返回 `success: true`，
 * 而配置文件内容原封不动，Agent 从未写进去，全程无任何异常或日志。
 *
 * `typeof null === 'object'` 是这个洞能存在的直接原因，数组同理（是 object、非 null，
 * 但没有 `agents` 语义）。
 */
describe('配置是合法 JSON 但不是对象时同样算「读不动」（对抗测试补漏）', () => {
  const notObjects: Array<[string, string, string]> = [
    ['null', 'null', 'null'],
    ['布尔 false', 'false', 'boolean'],
    ['数字 0', '0', 'number'],
    ['字符串', '"hello"', 'string'],
    ['数组', '[]', 'array'],
  ];

  for (const [label, content, expectedDetail] of notObjects) {
    it(`配置内容是 ${label} 时抛 notAnObject，而不是被当成一份可用的配置`, async () => {
      fs.writeFileSync(configPath, content);
      const { AgentProvisioner, ConfigReadError } = await import('../src/agent-provisioner');
      const provisioner = new AgentProvisioner();

      let caught: unknown;
      try {
        await provisioner.provision({ agentId: 'not-an-object-probe' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConfigReadError);
      expect((caught as InstanceType<typeof ConfigReadError>).reason).toBe('notAnObject');
      expect((caught as InstanceType<typeof ConfigReadError>).detail).toBe(expectedDetail);
    });
  }

  it('五种非对象内容各自的 detail 互不相同，不塌成同一个值', async () => {
    const { AgentProvisioner, ConfigReadError } = await import('../src/agent-provisioner');
    const details = new Set<string>();

    for (const [, content] of notObjects) {
      fs.writeFileSync(configPath, content);
      try {
        await new AgentProvisioner().provision({ agentId: 'detail-distinct-probe' });
      } catch (err) {
        if (err instanceof ConfigReadError) details.add(err.detail);
      }
    }

    expect(details.size).toBe(notObjects.length);
  });
});

/**
 * `ConfigReadError.detail` **绝不能带配置原文** —— 它会经 `errorDetail` 进 HTTP 响应体，
 * 而 `openclaw.json` 里存着各家模型的 apiKey。
 *
 * 本机 Node v24.19.0 实测，V8 的 JSON 报错分两类，只有一类安全：
 *   JSON.parse('{"apiKey":"sk-...","x":undefined}')
 *     → Unexpected token 'u', ..."7890","x":undefined}" is not valid JSON   ← 带原文
 *   JSON.parse('{"apiKey":"sk-...", }')
 *     → Expected double-quoted property name in JSON at position 33         ← 不带
 *
 * 判断「这一类会不会泄露」不该是调用方的责任，所以一律只留类别与位置数字。
 */
describe('配置解析报错不得把配置原文带进 detail（凭据泄露面）', () => {
  /**
   * 密钥必须**紧邻报错位置**，否则这条用例测不到自己声称要测的东西。
   *
   * V8 嵌入的片段窗口实测只有约 20 个字符：把一个长密钥放在配置深处时，
   * 漏出来的只是它的末尾两三位，`not.toContain(整串密钥)` 恒为真——
   * **在没有脱敏的旧代码上也是绿的**。第一版就是这么写的，红证时它没红，
   * 而它的标题却声称在防泄露。断言弱于标题正是本项目验收计划里点名禁止的写法。
   *
   * 这里用一个短 canary 并把它放在坏 token 前面，实测窗口内容为
   * `..."sk-LEAK","x":undefined}"` —— 未脱敏时必然含 `LEAK`。
   */
  const CANARY = 'sk-LEAK';

  it('undefined 值触发的那类报错（V8 会嵌入原文片段）不把紧邻的密钥带出来', async () => {
    fs.writeFileSync(configPath, `{"apiKey":"${CANARY}","x":undefined}`);
    const { AgentProvisioner, ConfigReadError } = await import('../src/agent-provisioner');

    let caught: unknown;
    try {
      await new AgentProvisioner().provision({ agentId: 'leak-probe' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigReadError);
    const err = caught as InstanceType<typeof ConfigReadError>;
    // detail 与 message 两条路径都要断：message 会进日志，detail 会进 HTTP 响应体。
    expect(err.detail).not.toContain('LEAK');
    expect(err.message).not.toContain('LEAK');
  });

  it('detail 只保留错误类别与位置数字这一种形状', async () => {
    fs.writeFileSync(configPath, `{"apiKey":"${CANARY}", }`);
    const { AgentProvisioner, ConfigReadError } = await import('../src/agent-provisioner');

    let caught: unknown;
    try {
      await new AgentProvisioner().provision({ agentId: 'shape-probe' });
    } catch (err) {
      caught = err;
    }

    const err = caught as InstanceType<typeof ConfigReadError>;
    // 形如 `SyntaxError at position 33`，或在没有位置信息时退化为 `SyntaxError`。
    expect(err.detail).toMatch(/^[A-Za-z]+Error( at position \d+)?$/);
  });
});

/**
 * 形状校验：**深一层的同类洞**（对抗测试第二轮，38 探针 / 9 失败）。
 *
 * 上一版只校验顶层是不是对象，因为当时报的是 `null`。同一类洞换个深度立刻复活：
 *
 *   `{"agents": []}`  顶层是对象、过校验，而 `ensureAgentEntry()` 的
 *   `if (!config.agents.list) config.agents.list = []` 是往一个**数组**上挂具名属性。
 *   内存里成功、push 也成功，但 `JSON.stringify` 序列化数组只走索引，
 *   那个属性凭空消失 —— 接口报 success:true，openclaw.json 一个字节没变，
 *   而 session 行已经建了，那个 ID 就此永久烧掉。
 *
 * `AGENTS.md` 对这件事有原话：「修这类洞时必须把同类入口一起过一遍……
 * 堵一个不堵其余等于没堵。」上一版正是只堵了被报出来的那一个。
 */
describe('配置形状校验覆盖写入路径真的会动的每一层（对抗测试第二轮）', () => {
  const badShapes: Array<[string, string, string]> = [
    ['agents 是数组', '{"agents":[]}', 'agents:array'],
    ['agents 是 null', '{"agents":null}', 'agents:null'],
    ['agents 是字符串', '{"agents":"x"}', 'agents:string'],
    ['agents.list 是对象', '{"agents":{"list":{}}}', 'agents.list:object'],
    ['agents.list 是 null', '{"agents":{"list":null}}', 'agents.list:null'],
    ['agents.list 里有 null 项', '{"agents":{"list":[null]}}', 'agents.list[0]'],
    ['agents.list 里有标量项', '{"agents":{"list":[{"id":"a"},7]}}', 'agents.list[1]'],
    ['agents.entries 是数组', '{"agents":{"entries":[]}}', 'agents.entries:array'],
    ['agents.defaults 是数组', '{"agents":{"defaults":[]}}', 'agents.defaults:array'],
  ];

  for (const [label, content, expectedDetail] of badShapes) {
    it(`${label} 时抛 notAnObject（detail=${expectedDetail}），而不是让写入静默丢失`, async () => {
      fs.writeFileSync(configPath, content);
      const { AgentProvisioner, ConfigReadError } = await freshProvisioner();

      let caught: unknown;
      try {
        await new AgentProvisioner().provision({ agentId: 'shape-probe' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConfigReadError);
      expect((caught as InstanceType<typeof ConfigReadError>).reason).toBe('notAnObject');
      expect((caught as InstanceType<typeof ConfigReadError>).detail).toBe(expectedDetail);
    });
  }

  it('对照组：合法形状（agents.list 是数组、成员是对象）照常写入，不被这道校验误伤', async () => {
    fs.writeFileSync(configPath, '{"agents":{"list":[{"id":"existing","workspace":"/tmp/x"}]}}');
    const { AgentProvisioner } = await freshProvisioner();

    await new AgentProvisioner().provision({ agentId: 'shape-ok' });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.agents.list.map((e: any) => e.id)).toContain('shape-ok');
    expect(written.agents.list.map((e: any) => e.id)).toContain('existing');
  });

  it('agents 是数组时，配置文件内容必须保持原样——不能出现「报成功但写丢了」', async () => {
    fs.writeFileSync(configPath, '{"agents":[]}');
    const before = fs.readFileSync(configPath, 'utf-8');
    const { AgentProvisioner } = await freshProvisioner();

    await expect(new AgentProvisioner().provision({ agentId: 'burn-probe' })).rejects.toThrow();

    // 这一条是这批用例的核心：旧代码在这里是「返回成功 + 文件没变」，
    // 新代码必须是「抛错 + 文件没变」。只断抛错不够，还要断没有半截写入。
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });
});

/**
 * `openclaw.json` 不是普通文件时不能挂死（对抗测试：命名管道让进程静默挂 60 秒）。
 */
describe('配置文件不是普通文件时快速失败，而不是挂死', () => {
  it('openclaw.json 是目录时抛 unreadable/isDirectory，不抛原始 fs 错误', async () => {
    fs.rmSync(configPath, { force: true });
    fs.mkdirSync(configPath);
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    try {
      provisioner.readConfigFile();
      expect.unreachable('应该抛 ConfigReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigReadError);
      expect((error as InstanceType<typeof ConfigReadError>).reason).toBe('unreadable');
      expect((error as InstanceType<typeof ConfigReadError>).detail).toBe('isDirectory');
    } finally {
      fs.rmSync(configPath, { recursive: true, force: true });
    }
  });
});

/**
 * `unreadable` 分支同样不得把绝对路径带进 detail。
 *
 * 解析分支上一轮已经脱敏了，这一条当时漏了——同一份数据经两条路出去，
 * 只脱敏一条等于没脱敏（对抗测试实测：HTTP 响应体里出现了用户的家目录绝对路径）。
 */
describe('unreadable 分支的 detail 不带绝对路径', () => {
  it('chmod 000 时 detail 是错误码而不是含路径的 message', async () => {
    if (process.getuid && process.getuid() === 0) return; // root 无视权限位
    fs.writeFileSync(configPath, '{}');
    fs.chmodSync(configPath, 0o000);
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();
    const provisioner: any = new AgentProvisioner();

    try {
      provisioner.readConfigFile();
      expect.unreachable('应该抛 ConfigReadError');
    } catch (error) {
      const err = error as InstanceType<typeof ConfigReadError>;
      expect(err.reason).toBe('unreadable');
      expect(err.detail).not.toContain(tmpHome);
      expect(err.detail).not.toContain('/');
      expect(err.detail).toBe('EACCES');
    }
  });
});

/**
 * `deprovision()` 在配置读不动时必须抛，不能返回 false。
 *
 * 原来它有一条独立的裸 `JSON.parse` + 外层 `catch → return false`，于是
 * `DELETE /api/sessions/:id` **返回 200 success**，而配置条目、工作区、
 * agent 状态目录、记忆库全都还在（对抗测试实证）。
 * 「删干净了」和「一个字节没删」在界面上长得一模一样。
 */
describe('deprovision() 不再把「配置读不动」报成删除成功', () => {
  it('配置损坏时抛 ConfigReadError，而不是返回 false 让路由报 200', async () => {
    fs.writeFileSync(configPath, '{ "agents": ');
    const { AgentProvisioner, ConfigReadError } = await freshProvisioner();

    await expect(new AgentProvisioner().deprovision('some-agent')).rejects.toThrow(ConfigReadError);
  });

  it('对照组：配置文件不存在时仍安静返回 false（合法状态，不该被误伤成抛错）', async () => {
    fs.rmSync(configPath, { force: true });
    const { AgentProvisioner } = await freshProvisioner();

    await expect(new AgentProvisioner().deprovision('some-agent')).resolves.toBe(false);
  });
});

/**
 * S2-A2-e · 接线之后的**端到端**：整条链路在两种形状下都工作。
 *
 * 门面的单元测试绿，不等于调用点接对了。Sprint 1 的教训之一是
 * 「模块函数正确但没有调用方」——所以这批用例从 `provision()` /
 * `deprovision()` 这些**真实入口**出发，断言落盘的文件内容。
 *
 * 审计表见 `.harness/s2-a2e-callsite-audit.md`：契约说四处，实际十一处。
 */
describe('名册门面接线：provision / deprovision 在两种形状下都落盘正确', () => {
  it('list 形状（生产机现状）：建、改、删都落在 agents.list 且不产生 entries 键', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agents: { list: [{ id: 'existing', workspace: '/w/existing' }] },
      models: { anthropic: { apiKey: 'sk-keep' } },
    }));
    const { AgentProvisioner } = await freshProvisioner();
    const p: any = new AgentProvisioner();

    await p.provision({ agentId: 'newbie' });
    let disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(disk.agents.list.map((e: any) => e.id)).toEqual(['existing', 'newbie']);
    expect('entries' in disk.agents).toBe(false);
    expect(disk.models.anthropic.apiKey).toBe('sk-keep');

    await p.deprovision('newbie');
    disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(disk.agents.list.map((e: any) => e.id)).toEqual(['existing']);
    expect('entries' in disk.agents).toBe(false);
  });

  it('entries 形状（2026.8.x）：建、改、删都落在 agents.entries 且不产生 list 键', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agents: { entries: { existing: { workspace: '/w/existing' } } },
      models: { anthropic: { apiKey: 'sk-keep' } },
    }));
    const { AgentProvisioner } = await freshProvisioner();
    const p: any = new AgentProvisioner();

    await p.provision({ agentId: 'newbie' });
    let disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Object.keys(disk.agents.entries).sort()).toEqual(['existing', 'newbie']);
    // **不产生 list 键** —— 这是「跟随现状、不擅自迁移」在落盘层面的断言
    expect('list' in disk.agents).toBe(false);
    // entries 形状下 id 是键，不重复存进值里
    expect('id' in disk.agents.entries.newbie).toBe(false);
    expect(disk.models.anthropic.apiKey).toBe('sk-keep');

    await p.deprovision('newbie');
    disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Object.keys(disk.agents.entries)).toEqual(['existing']);
    expect('list' in disk.agents).toBe(false);
  });

  it('调用方对 entry 的直接改写在两种形状下都真的落盘（不是改在副本上）', async () => {
    // 这条防的是一个不会报错的失败：`findRosterEntry` 返回副本，
    // 而调用方是 `entry.tools = {...}` 这样直接改的——改在副本上等于什么都没写，
    // 配置照常落盘、接口照常报成功，只是少了那些字段。
    for (const [label, initial] of [
      ['list', { agents: { list: [] } }],
      ['entries', { agents: { entries: {} } }],
    ] as const) {
      fs.writeFileSync(configPath, JSON.stringify(initial));
      const { AgentProvisioner } = await freshProvisioner();
      const p: any = new AgentProvisioner();

      await p.provision({ agentId: 'shaped', toolMode: 'off' });

      const disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const entry = label === 'list'
        ? disk.agents.list.find((e: any) => e.id === 'shaped')
        : disk.agents.entries.shaped;
      expect(entry, `${label} 形状下没找到落盘的条目`).toBeTruthy();
      // toolMode: 'off' → tools: { deny: ['*'] }。这是调用方直接改 entry 写进去的字段。
      expect(entry.tools, `${label} 形状下调用方的改写没有落盘`).toEqual({ deny: ['*'] });
    }
  });
});

/**
 * S2-A4 · 系统提示词报告的来源必须是**三态**，不是「有/没有」。
 *
 * OpenClaw 2026.8 把会话从 `agents/<id>/sessions/sessions.json` 迁进了
 * `openclaw-agent.sqlite`。旧代码在 2.x 上读不到那个 JSON，返回 `null`——
 * 而「这个 agent 真的还没跑过」也是 `null`。界面上两者都是一片空白，
 * 用户分不出「我还没用它」和「引擎升级了、这个指标现在读不到」。
 *
 * 生产机上有 7 份真实的 sessions.json，升级后它们全部变成读不到——
 * 也就是说这个降级会同时发生在 7 个 agent 上。
 */
describe('S2-A4 · 指标来源三态：读不到 ≠ 没有数据', () => {
  const agentDir = (id: string) => path.join(tmpHome, '.openclaw', 'agents', id);

  it('无 sessions.json + **有** sqlite 会话库 → unavailable-on-2x（诚实降级）', async () => {
    fs.mkdirSync(agentDir('a2x'), { recursive: true });
    fs.writeFileSync(path.join(agentDir('a2x'), 'openclaw-agent.sqlite'), 'not-really-sqlite');
    const { AgentProvisioner } = await freshProvisioner();

    const m = new AgentProvisioner().readAgentRuntimeMetrics('a2x');
    expect(m.systemPrompt.source).toBe('unavailable-on-2x');
    expect(m.tools.source).toBe('unavailable-on-2x');
  });

  it('无 sessions.json + **无** sqlite → agent-files / none（真的没数据）', async () => {
    fs.mkdirSync(agentDir('afresh'), { recursive: true });
    const { AgentProvisioner } = await freshProvisioner();

    const m = new AgentProvisioner().readAgentRuntimeMetrics('afresh');
    // 两个方向都断：必须是「没数据」那一态，**且不等于**「读不到」那一态
    expect(m.systemPrompt.source).toBe('agent-files');
    expect(m.tools.source).toBe('none');
    expect(m.systemPrompt.source).not.toBe('unavailable-on-2x');
  });

  it('有 sessions.json 且含报告 → latest-run，且数字读得出来', async () => {
    const dir = path.join(agentDir('aok'), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      s1: { updatedAt: 1, systemPromptReport: { generatedAt: 1, systemPrompt: { chars: 4321 }, tools: { schemaChars: 99 } } },
    }));
    const { AgentProvisioner } = await freshProvisioner();

    const m = new AgentProvisioner().readAgentRuntimeMetrics('aok');
    expect(m.systemPrompt.source).toBe('latest-run');
    expect(m.systemPrompt.systemChars).toBe(4321);
  });

  it('三种情形的 source 互不相同——不塌成同一个值', async () => {
    // 三种情形必须在**同一个用例**里构造：`beforeEach` 每次都重建临时 HOME，
    // 分散在三个 it 里的话，第四个用例看到的是一个空目录。
    // （第一版就是这么写的，红证时才发现——用例之间不共享状态是对的，
    // 是我把它当成共享了。）
    fs.mkdirSync(path.join(agentDir('x2x')), { recursive: true });
    fs.writeFileSync(path.join(agentDir('x2x'), 'openclaw-agent.sqlite'), 'x');

    fs.mkdirSync(agentDir('xfresh'), { recursive: true });

    const dir = path.join(agentDir('xok'), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      s1: { updatedAt: 1, systemPromptReport: { generatedAt: 1, systemPrompt: { chars: 7 } } },
    }));

    const { AgentProvisioner } = await freshProvisioner();
    const p = new AgentProvisioner();
    const sources = ['x2x', 'xfresh', 'xok'].map((id) => p.readAgentRuntimeMetrics(id).systemPrompt.source);

    expect(sources).toEqual(['unavailable-on-2x', 'agent-files', 'latest-run']);
    expect(new Set(sources).size).toBe(3);
  });
});

/**
 * S2-A6 · OpenClaw 2.0 合并掉的 provider 前缀 —— 只在比较时归一，不改写文件。
 *
 * 上游 2026.8.1 把 `codex/*` 与 `openai-codex/*` 合并进了 `openai/*`。
 * 用户升级并跑过 doctor 之后，配置里的 id 变成新前缀，而 ClawOPT 数据库里
 * 存着的 agent 模型引用仍是旧前缀——校验对不上，`Unknown model id` 抛出来，
 * 而用户什么都没做错。
 *
 * **如实记一笔**：生产机（2026-09-03 实测）上 `agents.defaults.models` 只有
 * 一个 id `deepseek/deepseek-v4-flash`，**一个 codex 都没有**。
 * 这条改动在那台机器上是空操作，没有被真机验证过。
 */
describe('S2-A6 · codex/* 与 openai-codex/* 归一到 openai/*', () => {
  const withModels = (ids: string[]) => JSON.stringify({
    agents: { defaults: { models: Object.fromEntries(ids.map((id) => [id, {}])) }, list: [] },
  });

  it('配置里是新前缀、引用是旧前缀时，校验通过（升级后的常见情形）', async () => {
    fs.writeFileSync(configPath, withModels(['openai/gpt-5.4']));
    const { AgentProvisioner } = await freshProvisioner();
    await expect(
      new AgentProvisioner().provision({ agentId: 'a', model: 'codex/gpt-5.4' } as any),
    ).resolves.not.toThrow();
  });

  it('配置里是旧前缀、引用是新前缀时也通过（反方向）', async () => {
    fs.writeFileSync(configPath, withModels(['openai-codex/gpt-5.4']));
    const { AgentProvisioner } = await freshProvisioner();
    await expect(
      new AgentProvisioner().provision({ agentId: 'b', model: 'openai/gpt-5.4' } as any),
    ).resolves.not.toThrow();
  });

  it('**真的不存在的模型仍然报错**——归一不是「一律放行」', async () => {
    fs.writeFileSync(configPath, withModels(['openai/gpt-5.4']));
    const { AgentProvisioner } = await freshProvisioner();
    await expect(
      new AgentProvisioner().provision({ agentId: 'c', model: 'anthropic/nope' } as any),
    ).rejects.toThrow(/Unknown model id/);
  });

  it('归一只发生在比较时，**磁盘上的配置一个字节都不改**', async () => {
    fs.writeFileSync(configPath, withModels(['openai/gpt-5.4']));
    const before = fs.readFileSync(configPath, 'utf-8');
    const { AgentProvisioner } = await freshProvisioner();

    // 用一个不会触发写入的只读路径来验：读模型列表
    new AgentProvisioner().readAvailableModels();
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });
});

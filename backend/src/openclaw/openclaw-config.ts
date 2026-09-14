/**
 * 读 `~/.openclaw/` 下配置文件的**唯一入口**。
 *
 * ## 为什么这个模块存在
 *
 * 在它之前，全仓库有七处各自为政的 `JSON.parse(fs.readFileSync(configPath, 'utf-8'))`
 * （`index.ts` 六处 + `agent-provisioner.ts` 一处），每一处的失败处理都不一样。
 * 对抗测试连续三轮打在同一个位置上，每轮都是「上一轮修了被报出来的那一处，
 * 剩下几处原样不动」：
 *
 * - **凭据泄露**：V8 的 JSON 报错有一类会把输入原文嵌进 message
 *   （`Unexpected token 'u', ..."sk-LEAK","x":undefined}" is not valid JSON`），
 *   而 `openclaw.json` 里存着 `gateway.auth.token`、`gateway.auth.password`
 *   和每一家模型的 apiKey。这些 message 被原样塞进 HTTP 响应体。
 *   上一轮只给其中一处加了脱敏——**六条路里防住一条等于没防**。
 * - **挂死**：配置文件是命名管道时，同步 `readFileSync` 永久阻塞。
 *   上一轮只给 `openclaw.json` 那一处加了 `statSync().isFile()` 闸门，
 *   于是把 `clawopt-models.json` 换成管道，一次 `GET /api/models`
 *   就让整个后端所有路由永久挂起，无日志，要 `kill -9`。
 * - **形状**：`JSON.parse` 对 `null` / `[]` / `{"agents":[]}` 全都成功返回，
 *   而写入路径会在这些形状上静默丢失数据。
 *
 * 本仓库 `AGENTS.md` 对这件事有原话：
 * 「修这类洞时必须把同类入口一起过一遍……**堵一个不堵其余等于没堵**。」
 * 那句话是为 `served-paths.ts` 那次事故写的（只堵了 download，
 * 紧挨着的三个 preview 路由漏了三个月）。这个模块是它在配置这条线上的落点：
 * **判据只实现一次，入口只有一个。**
 *
 * ## 与 `served-paths.ts` 的对称
 *
 * 一切按路径出文件的接口都过 `assertServablePath()`；
 * 一切读 `~/.openclaw` 下配置的代码都过这里。同一个形状，同一个理由。
 *
 * ## 写入侧在 `config-atomic-write.ts`
 *
 * 读写分成两个模块是有意的：读的判据是「安全地拿到内容」，
 * 写的判据是「不要在崩溃时毁掉用户唯一一份配置」，两者没有共享状态。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 配置读取失败。**四种原因必须可分辨**——调用方需要知道该让用户去修什么。 */
export class ConfigReadError extends Error {
  constructor(
    public readonly reason: 'unreadable' | 'parseError' | 'jsonWithComments' | 'notAnObject',
    public readonly detail: string,
    /** 出错的是哪个文件（只留文件名，不留路径——路径含用户名）。 */
    public readonly file: string = 'openclaw.json',
  ) {
    super(`${file} 读取失败（${reason}）：${detail}`);
    this.name = 'ConfigReadError';
  }
}

/**
 * 把底层报错压成「类别 + 位置」，**绝不带原文片段，也不带路径**。
 *
 * 本机 Node v24.19.0 实测，V8 的 JSON 报错分两类，只有一类安全：
 *
 *   JSON.parse('{"apiKey":"sk-LEAK","x":undefined}')
 *     → Unexpected token 'u', ..."sk-LEAK","x":undefined}" is not valid JSON   ← 带原文
 *   JSON.parse('{"apiKey":"sk-LEAK", }')
 *     → Expected double-quoted property name in JSON at position 33            ← 不带
 *
 * 判断「这一类会不会泄露」不该是调用方的责任，所以一律只留类别与数字。
 * `fs` 的报错同理：`EACCES: permission denied, open '/Users/<用户名>/...'`
 * 会把主机路径和用户名交出去。
 */
export function sanitizeErrorDetail(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code) return code;
  const raw = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(raw)?.[1];
  return position ? `${name} at position ${position}` : name;
}

/** 只认「普通对象」：数组、null、标量都不算。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getOpenClawDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

export function getOpenClawConfigPath(): string {
  return path.join(getOpenClawDir(), 'openclaw.json');
}

/**
 * 读取结果。**用带标签的返回值，不用 `null` 当哨兵。**
 *
 * 第一版这个函数用 `null` 同时表示「文件不存在」和「内容就是 `null`」——
 * 而 `JSON.parse('null')` 恰好就返回 `null`，于是一份内容为 `null` 的配置
 * 被当成「全新安装」放行，装配又一次报成功而什么都没写。
 * 这正是本模块存在的理由（把两个不同状态塌进同一个 falsy 值）在模块自己身上重演了一次，
 * 红证时被两条既有用例抓住。如实记在这里，因为它比任何说教都能说明这个陷阱有多滑。
 */
export type ConfigReadResult =
  | { readonly exists: false }
  | { readonly exists: true; readonly value: unknown };

/**
 * 安全地读一个 JSON 配置文件。**这是本模块唯一的读取实现**。
 *
 * `{ exists: false }` 只有一种含义：文件不存在（全新安装，合法状态）。
 * 其余一切失败都抛 `ConfigReadError`——把「读不动」塌成一个 falsy 值，
 * 会让调用方把它当成「没有配置」，那正是本项目修了三轮的那类失败。
 */
export function readJsonConfigSafe(filePath: string): ConfigReadResult {
  const fileName = path.basename(filePath);

  // stat 闸门与读取都在 `readTextFileSafe()` 里——判据只留一份。
  const text = readTextFileSafe(filePath);
  if (!text.exists) return { exists: false };
  const raw = text.value as string;

  try {
    return { exists: true, value: JSON.parse(raw) };
  } catch (error) {
    const looksLikeJson5 = /(^|[^:"])\/\/|\/\*/.test(raw);
    throw new ConfigReadError(
      looksLikeJson5 ? 'jsonWithComments' : 'parseError',
      sanitizeErrorDetail(error),
      fileName,
    );
  }
}

/**
 * 断言这个路径是一个**普通文件**——闸门本身，不读内容。
 *
 * 为什么单独抽出来：闸门要守的判据是「同步操作一个我们不控制的路径」，
 * 而这跟「是不是在读」无关。第五轮对抗测试从两个不叫 read 的地方进来：
 *
 *   · `fs.copyFileSync(mainAuthPath, ...)` —— 复制 auth-profiles.json。
 *     把它换成命名管道，建一个 Agent 就让整个后端永久挂住
 *     （栈：`node::fs::CopyFile → uv_fs_copyfile`）。
 *
 * 「读」只是这类操作的一种拼写。任何会打开一个数据来源路径的同步调用
 * ——copy / open / createReadStream / rename——都要先过这一关。
 */
export function assertRegularFile(filePath: string): void {
  const fileName = path.basename(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new ConfigReadError('unreadable', sanitizeErrorDetail(error), fileName);
  }
  if (!stat.isFile()) {
    throw new ConfigReadError(
      'unreadable',
      stat.isDirectory() ? 'isDirectory' : stat.isFIFO() ? 'isFIFO' : 'notARegularFile',
      fileName,
    );
  }
}

/**
 * 安全地读一个**纯文本**配置文件（不解析 JSON）。
 *
 * 存在的理由与 `readJsonConfigSafe()` 相同——挂死与路径泄露这两条判据
 * 跟「内容是不是 JSON」无关。第四轮对抗测试正是从这个缺口进来的：
 * `snapshotTextFile()` 读配置文件做快照，那一行上没有 `JSON.parse`，
 * 于是既躲过了网关也躲过了当时那条按行匹配的守卫，
 * 一个命名管道就能让 `POST /api/config/max-permissions` **永久挂住整个后端**。
 */
export function readTextFileSafe(filePath: string): ConfigReadResult {
  const fileName = path.basename(filePath);
  if (!fs.existsSync(filePath)) return { exists: false };

  assertRegularFile(filePath);

  try {
    return { exists: true, value: fs.readFileSync(filePath, 'utf-8') };
  } catch (error) {
    throw new ConfigReadError('unreadable', sanitizeErrorDetail(error), fileName);
  }
}

/**
 * 校验**写入路径真的会去动的那几层**，不做全量 schema 校验。
 *
 * 为什么不做全量：用户的 `openclaw.json` 里有大量本项目不关心的配置，
 * 替上游校验它们既越权，又会在上游加字段时误伤。
 *
 * 为什么必须做这几层：`{"agents": []}` 顶层是对象、能过「是不是对象」这一关，
 * 而 `ensureAgentEntry()` 的 `if (!config.agents.list) config.agents.list = []`
 * 是往一个**数组**上挂具名属性——内存里成功、push 也成功，
 * 但 `JSON.stringify` 序列化数组只走索引，那个属性**凭空消失**。
 * 净效果：装配报 `success: true`，配置一个字节没变，Agent 从未写进去。
 */
export function assertUsableConfigShape(config: Record<string, unknown>, fileName = 'openclaw.json'): void {
  const bad = (key: string, value: unknown) =>
    new ConfigReadError(
      'notAnObject',
      `${key}:${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`,
      fileName,
    );

  if ('agents' in config && config.agents !== undefined && !isPlainObject(config.agents)) {
    throw bad('agents', config.agents);
  }

  const agents = (config.agents ?? {}) as Record<string, unknown>;

  // `agents.list` 必须是数组：写入路径会对它 `.find()` / `.push()` / `.filter()`。
  // 给一个对象的话 `.push` 直接 TypeError，而那个 TypeError 会在启动期
  // `ensureMainAgent()` 里**炸死整个进程**（实测：后端死在 listen 之前）。
  if ('list' in agents && agents.list !== undefined && !Array.isArray(agents.list)) {
    throw bad('agents.list', agents.list);
  }

  // 数组里的每一项也要是对象：`[null]` 会让 `item.id` 抛 TypeError。
  if (Array.isArray(agents.list)) {
    const badIndex = agents.list.findIndex((item) => !isPlainObject(item));
    if (badIndex >= 0) {
      throw new ConfigReadError('notAnObject', `agents.list[${badIndex}]`, fileName);
    }
  }

  // `agents.entries` 是 OpenClaw 2026.8.x 的新形状（Sprint 2 才会去写它）。
  // 形状校验先补上：读到一个坏的 entries 而不出声，等于给 Sprint 2 埋雷。
  if ('entries' in agents && agents.entries !== undefined && !isPlainObject(agents.entries)) {
    throw bad('agents.entries', agents.entries);
  }

  if ('defaults' in agents && agents.defaults !== undefined && !isPlainObject(agents.defaults)) {
    throw bad('agents.defaults', agents.defaults);
  }
}

/**
 * 读 `openclaw.json`：安全读 + 顶层是对象 + 形状校验。
 *
 * 文件不存在返回 `null`；其余一切失败抛 `ConfigReadError`。
 * **全仓库读 `openclaw.json` 都必须走这里**，不要再写 `JSON.parse(fs.readFileSync(...))`。
 */
// 返回 `any` 而不是 `Record<string, unknown>`：这份配置的 schema 属于上游 OpenClaw，
// 本项目只关心其中几个键，其余部分随上游版本变化。用严格类型会逼调用点写一堆
// 无意义的 cast，而**真正的保证来自运行时的 `assertUsableConfigShape()`**，
// 不是来自编译期。仓库其余读配置的地方（`agent-provisioner` 原来的 `readConfigFile`）
// 也是这个约定，这里保持一致。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readOpenClawConfigSafe(): any | null {
  const result = readJsonConfigSafe(getOpenClawConfigPath());
  if (!result.exists) return null;

  const parsed = result.value;
  if (!isPlainObject(parsed)) {
    throw new ConfigReadError(
      'notAnObject',
      Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed,
    );
  }

  assertUsableConfigShape(parsed);
  return parsed;
}

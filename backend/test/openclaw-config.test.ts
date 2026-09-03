/**
 * 配置网关 —— 判据只实现一次，入口只有一个。
 *
 * 这批用例存在的理由，是对抗测试**连续三轮**打在同一个位置上：
 * 每一轮都修好了被报出来的那一处，而剩下几处原样不动。
 * 三轮下来暴露的是同一件事——全仓库有十处各自为政的
 * `JSON.parse(fs.readFileSync(...))`，每处的失败处理都不一样。
 *
 * `AGENTS.md` 对这件事有原话：「修这类洞时必须把同类入口一起过一遍……
 * 堵一个不堵其余等于没堵。」这批用例钉的就是「只有一个入口」这件事。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ConfigReadError,
  readJsonConfigSafe,
  sanitizeErrorDetail,
  assertRegularFile,
} from '../src/openclaw-config';

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-gw-'));
  target = path.join(dir, 'openclaw.json');
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test] 清理临时目录失败：', err);
  }
});

describe('文件不存在与「内容就是 null」是两件事', () => {
  it('文件不存在返回 { exists: false }，不是 null', () => {
    expect(readJsonConfigSafe(target)).toEqual({ exists: false });
  });

  it('内容是 null 时返回 { exists: true, value: null } —— 不许塌成「文件不存在」', () => {
    // 第一版网关用 `null` 同时当「不存在」的哨兵和解析结果，而
    // `JSON.parse('null') === null`，于是一份内容为 null 的配置被当成全新安装放行。
    // 这正是本模块要消灭的那类失败，在模块自己身上重演了一次。
    fs.writeFileSync(target, 'null');
    expect(readJsonConfigSafe(target)).toEqual({ exists: true, value: null });
  });
});

describe('非普通文件快速失败，而不是永久挂死', () => {
  it('命名管道（FIFO）立即抛 unreadable/isFIFO，不阻塞', () => {
    const fifo = path.join(dir, 'clawopt-models.json');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch (err) {
      console.warn('[test] 本平台建不了 FIFO，跳过：', err);
      return;
    }

    // 核心：这一句在旧代码里会**永久阻塞**。用例能跑完本身就是断言的一部分。
    const started = Date.now();
    try {
      readJsonConfigSafe(fifo);
      expect.unreachable('应该抛 ConfigReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigReadError);
      expect((error as ConfigReadError).reason).toBe('unreadable');
      expect((error as ConfigReadError).detail).toBe('isFIFO');
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('目录抛 unreadable/isDirectory', () => {
    fs.mkdirSync(target);
    try {
      readJsonConfigSafe(target);
      expect.unreachable('应该抛 ConfigReadError');
    } catch (error) {
      expect((error as ConfigReadError).detail).toBe('isDirectory');
    }
  });
});

describe('报错细节永远不带配置原文、路径或用户名', () => {
  const CANARY = 'sk-LEAK';

  it('V8 会嵌入原文的那类解析报错，密钥不出现在 detail / message 里', () => {
    fs.writeFileSync(target, `{"apiKey":"${CANARY}","x":undefined}`);
    try {
      readJsonConfigSafe(target);
      expect.unreachable('应该抛 ConfigReadError');
    } catch (error) {
      const err = error as ConfigReadError;
      expect(err.detail).not.toContain('LEAK');
      expect(err.message).not.toContain('LEAK');
    }
  });

  it('权限不足时 detail 是 errno，不含绝对路径与用户名', () => {
    if (process.getuid && process.getuid() === 0) return;
    fs.writeFileSync(target, '{}');
    fs.chmodSync(target, 0o000);
    try {
      readJsonConfigSafe(target);
      expect.unreachable('应该抛 ConfigReadError');
    } catch (error) {
      const err = error as ConfigReadError;
      expect(err.detail).toBe('EACCES');
      expect(err.message).not.toContain(os.homedir());
      expect(err.message).not.toContain('/');
    } finally {
      fs.chmodSync(target, 0o644);
    }
  });

  it('错误里只带文件名，不带目录 —— 路径含用户名', () => {
    fs.writeFileSync(target, '{ ');
    try {
      readJsonConfigSafe(target);
      expect.unreachable('应该抛 ConfigReadError');
    } catch (error) {
      const err = error as ConfigReadError;
      expect(err.file).toBe('openclaw.json');
      expect(err.message).not.toContain(dir);
    }
  });

  it('sanitizeErrorDetail 对 errno 错误返回 code，对解析错误返回「类别 + 位置」', () => {
    const errno = Object.assign(new Error("EACCES: permission denied, open '/Users/someone/.openclaw/openclaw.json'"), { code: 'EACCES' });
    expect(sanitizeErrorDetail(errno)).toBe('EACCES');

    let parseErr: unknown;
    try { JSON.parse('{"a": }'); } catch (e) { parseErr = e; }
    expect(sanitizeErrorDetail(parseErr)).toMatch(/^[A-Za-z]+Error( at position \d+)?$/);
  });
});

describe('全仓库不再有第二条读配置的实现', () => {
  it('这条守卫已被 fs-call-sites.test.ts 的棘轮取代 —— 记录它为什么不够', () => {
    // 这里原来是一条按行匹配的正则：要求同一行同时出现 `JSON.parse(fs.readFileSync`
    // 和一个小写关键词（configPath / openclaw.json / ...）。
    //
    // 第四轮对抗测试**五处**绕过了它，每一处只是换了个拼写：
    //   · 那一行上根本没有 JSON.parse（snapshotTextFile 读纯文本）
    //   · 变量名叫 sessionsJsonPath，不含关键词
    //   · 变量名是大写的 OPENCLAW_CONFIG_PATH，正则大小写敏感（两处）
    //   · 文件名 exec-approvals.json 不在关键词表里
    //
    // 其中两处是可复现的**永久挂死整个后端**（命名管道 + 同步读）。
    //
    // 教训：那道守卫本身就是一次实例级修复——它证明的是「没有人用我见过的写法
    // 犯错」，而不是「没有人犯错」。这与它要防的毛病是同一个形状。
    //
    // 替代品在 `fs-call-sites.test.ts`：枚举 src/ 下**每一个** fs 读写调用，
    // 与签入的基线逐条比对。它数的是 API 调用本身，不是路径表达式长什么样，
    // 所以换任何拼写都躲不过去。
    //
    // 这条用例只留一句断言，作用是让上面这段话跟着代码走，而不是躺在某个报告里。
    const ratchet = path.resolve(__dirname, 'fs-call-sites.test.ts');
    expect(fs.existsSync(ratchet)).toBe(true);
  });
});

/**
 * 判据是「路径是不是数据给的」，不是「文件是不是配置」——第五轮对抗测试最普适的一条。
 *
 * **闸门守的是容器，守不住那只从容器里伸出来指向别处的手。**
 * `sessions.json` 本身已经过网关了，但它内容里的 `sessionFile` 字段所指的路径没有；
 * 在那儿放一个命名管道，一条群消息就让整个后端永久挂住——
 * 端口还 LISTEN、日志一声不吭、要 kill -9。默认安装不开登录，匿名可达。
 *
 * 同一个触发条件还有第二种拼写：`copyFileSync` 复制 auth-profiles.json。
 * 它不叫 read，所以既不在网关的视野里，也不在守卫的词表里。
 */
describe('数据给的路径同样要过闸门（不只是"配置文件"）', () => {
  it('assertRegularFile 对命名管道立即抛，不阻塞 —— 这是 copyFileSync 那条路的闸门', () => {
    const fifo = path.join(dir, 'auth-profiles.json');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch (err) {
      console.warn('[test] 本平台建不了 FIFO，跳过：', err);
      return;
    }

    // 关键在于「立即」：旧代码在这里是 copyFileSync 永久阻塞，
    // 而**挂死不会让用例变红，只会让它永远不结束**（lessons L7 第 3 条）。
    // 所以必须显式断言耗时。
    const started = Date.now();
    expect(() => assertRegularFile(fifo)).toThrow(ConfigReadError);
    expect(Date.now() - started).toBeLessThan(1000);

    try {
      assertRegularFile(fifo);
    } catch (error) {
      expect((error as ConfigReadError).detail).toBe('isFIFO');
    }
  });

  it('普通文件照常通过，不被这道闸门误伤', () => {
    fs.writeFileSync(target, '{}');
    expect(() => assertRegularFile(target)).not.toThrow();
  });
});

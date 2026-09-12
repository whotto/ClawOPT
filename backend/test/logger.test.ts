/**
 * 结构化日志与脱敏 —— v1.6.0。
 *
 * ## 为什么需要它
 *
 * 这个产品的排障场景是「用户在自己的 Linux 主机上，你看不见」。CHANGELOG 里几乎
 * 每条修复都写着「生产实测」「真机上才看得见」。而现在能拿到的现场只有
 * `index.ts` 里 91 处 `console.*`，没有 request id、没有结构化字段、没有可导出的缓冲。
 *
 * ## 为什么脱敏是这个模块的头等大事
 *
 * 这些日志会经 `/api/diagnostics` 从 HTTP 吐出去。一旦带出 apiKey、会话令牌、
 * 或含用户名的绝对路径，就是把 v1.2.3 修过的那个洞按原样换个出口重开一次——
 * 当时的原话是「配置解析报错把凭据带进 HTTP 响应体」。
 *
 * 所以这里的判据不是「日志好不好看」，而是：**任何进入缓冲区的东西都必须先过脱敏**，
 * 且脱敏对**嵌套结构**同样生效——只洗顶层字段是上一类事故的形状。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import {
  LOG_BUFFER_LIMIT,
  createLogger,
  recentLogEntries,
  redactLogValue,
  resetLogBufferForTests,
} from '../src/logger';

beforeEach(() => resetLogBufferForTests());

describe('脱敏', () => {
  it('按**字段名**抹掉凭据类值', () => {
    const out = redactLogValue({
      apiKey: 'sk-live-abcdef123456',
      password: 'hunter2',
      authToken: 'zzz',
      cookie: 'clawopt_session=abc',
      model: 'claude-sonnet-5',
    }) as Record<string, unknown>;

    expect(out.apiKey).toBe('[redacted]');
    expect(out.password).toBe('[redacted]');
    expect(out.authToken).toBe('[redacted]');
    expect(out.cookie).toBe('[redacted]');
    expect(out.model, '普通字段不该被误伤').toBe('claude-sonnet-5');
  });

  it('按**值的形状**抹掉像密钥的字符串，即使字段名无辜', () => {
    // 真实事故里泄露往往发生在 `detail` / `message` / `raw` 这类无辜字段上。
    const out = redactLogValue({ detail: '调用失败：sk-live-abcdefghijklmnop 无效' }) as Record<string, unknown>;
    expect(out.detail).not.toContain('sk-live-abcdefghijklmnop');
  });

  it('**嵌套结构**同样脱敏——只洗顶层等于没洗', () => {
    const out = redactLogValue({
      config: { models: { anthropic: { apiKey: 'sk-nested-1234567890' } } },
      list: [{ apiKey: 'sk-in-array-1234567890' }],
    }) as any;
    // 无辜的父级（config / models / anthropic）保留结构，深处的凭据仍被抹掉。
    expect(out.config.models.anthropic.apiKey).toBe('[redacted]');
    expect(out.list[0].apiKey).toBe('[redacted]');
  });

  it('敏感键下面的**整棵子树**都抹掉，不钻进去逐个挑', () => {
    // 这是刻意的取舍：`auth` / `credential` 这类键下面装的几乎一定是凭据，
    // 而「钻进去只抹认得出的叶子」会漏掉词表之外的字段名。
    // 这个缓冲区会经 /api/diagnostics 从 HTTP 出去，宁可少看见，不可漏出去。
    const out = redactLogValue({ gateway: { auth: { token: 'x', method: 'device' } } }) as any;
    expect(out.gateway.auth).toBe('[redacted]');
  });

  it('把家目录换成 ~，不带出用户名', () => {
    const home = os.homedir();
    const out = redactLogValue({ path: `${home}/.openclaw/openclaw.json` }) as Record<string, unknown>;
    expect(out.path).toBe('~/.openclaw/openclaw.json');
    expect(String(out.path)).not.toContain(home);
  });

  it('Error 只留类别与错误码，不留 message 原文与 stack', () => {
    // V8 有一类 JSON 报错会把输入原文嵌进 message —— 那正是 v1.2.3 的泄露路径。
    const err = Object.assign(new SyntaxError('Unexpected token in {"apiKey":"sk-LEAK"}'), { code: 'EBADJSON' });
    const out = redactLogValue({ err }) as any;
    expect(JSON.stringify(out)).not.toContain('sk-LEAK');
    expect(JSON.stringify(out)).not.toContain('at Object');
    expect(out.err.name).toBe('SyntaxError');
  });

  it('循环引用不死循环', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(() => redactLogValue(a)).not.toThrow();
  });
});

describe('日志缓冲区', () => {
  it('记下结构化条目：时间、级别、标签、正文、字段', () => {
    createLogger('Gateway').info('已连接', { attempt: 2 });
    const [entry] = recentLogEntries();

    expect(entry.level).toBe('info');
    expect(entry.tag).toBe('Gateway');
    expect(entry.msg).toBe('已连接');
    expect(entry.fields).toEqual({ attempt: 2 });
    expect(Number.isNaN(Date.parse(entry.ts)), 'ts 不是可解析的时间戳').toBe(false);
  });

  it('**写入缓冲区之前就脱敏**——不是导出时才洗', () => {
    // 导出时再洗，意味着凭据在进程内存里以明文躺着，且任何绕过导出口的读取都能拿到。
    createLogger('Models').warn('刷新失败', { apiKey: 'sk-live-abcdefghijklmnop' });
    expect(JSON.stringify(recentLogEntries())).not.toContain('sk-live-abcdefghijklmnop');
  });

  it('有上限，超出后丢最旧的，最新的在末尾', () => {
    const log = createLogger('Bulk');
    for (let i = 0; i < LOG_BUFFER_LIMIT + 25; i++) log.info(`第 ${i} 条`);

    const entries = recentLogEntries(LOG_BUFFER_LIMIT + 100);
    expect(entries).toHaveLength(LOG_BUFFER_LIMIT);
    expect(entries[entries.length - 1].msg).toBe(`第 ${LOG_BUFFER_LIMIT + 24} 条`);
    expect(entries[0].msg).toBe(`第 25 条`);
  });

  it('limit 只取最近若干条', () => {
    const log = createLogger('Tail');
    ['a', 'b', 'c'].forEach((m) => log.info(m));
    expect(recentLogEntries(2).map((e) => e.msg)).toEqual(['b', 'c']);
  });

  it('requestId 跟着子 logger 走，方便把一次请求的多条串起来', () => {
    const log = createLogger('Chat').withRequestId('req-123');
    log.info('开始');
    log.error('失败');
    expect(recentLogEntries().map((e) => e.requestId)).toEqual(['req-123', 'req-123']);
  });

  it('没有 requestId 时字段缺席，而不是塞一个假的', () => {
    createLogger('Boot').info('启动');
    expect(recentLogEntries()[0].requestId).toBeUndefined();
  });
});

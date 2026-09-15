/**
 * 定时任务控制面：预设 ↔ cron 表达式往返、参数构造与校验、版本号不受运行状态影响。
 */
import { describe, expect, it } from 'vitest';
import {
  cronToPreset,
  formatEveryDuration,
  parseEveryDuration,
  presetToCron,
  type SchedulePreset,
} from '../src/control/cron/cron-schedule';
import { buildCronArgs, cronJobRevision, normalizeCronJob, createCronService } from '../src/control/cron/cron-service';
import { ControlInputError } from '../src/control/shared/control-http';

describe('预设 ↔ cron 往返', () => {
  const presets: SchedulePreset[] = [
    { kind: 'everyMinutes', minutes: 1 },
    { kind: 'everyMinutes', minutes: 15 },
    { kind: 'everyMinutes', minutes: 7 },
    { kind: 'hourly', minute: 0 },
    { kind: 'hourly', minute: 45 },
    { kind: 'daily', hour: 9, minute: 30 },
    { kind: 'weekly', weekdays: [1, 3, 5], hour: 18, minute: 0 },
    { kind: 'weekly', weekdays: [0], hour: 0, minute: 5 },
    { kind: 'monthly', day: 1, hour: 8, minute: 0 },
    { kind: 'custom', expr: '0 9 * 1-6 1-5' },
  ];

  it.each(presets.map((preset) => [JSON.stringify(preset), preset] as const))('%s', (_label, preset) => {
    const expr = presetToCron(preset);
    expect(cronToPreset(expr)).toEqual(preset);
    expect(presetToCron(cronToPreset(expr))).toBe(expr);
  });

  it('预设输出的是规范 5 段表达式', () => {
    expect(presetToCron({ kind: 'everyMinutes', minutes: 15 })).toBe('*/15 * * * *');
    expect(presetToCron({ kind: 'daily', hour: 9, minute: 30 })).toBe('30 9 * * *');
    expect(presetToCron({ kind: 'weekly', weekdays: [5, 1, 3, 1], hour: 18, minute: 0 })).toBe('0 18 * * 1,3,5');
    expect(presetToCron({ kind: 'monthly', day: 15, hour: 23, minute: 59 })).toBe('59 23 15 * *');
  });

  it('非规范写法认成自定义，保住用户的字面量', () => {
    for (const expr of ['*/1 * * * *', '05 9 * * *', '0 9 * * 5,1', '0 9 1 * 1', '0 9 * 2 *', '0 */2 * * *', '0 0 9 * * *']) {
      expect(cronToPreset(expr)).toEqual({ kind: 'custom', expr });
    }
  });

  it('越界值被拒', () => {
    expect(() => presetToCron({ kind: 'daily', hour: 24, minute: 0 })).toThrow(RangeError);
    expect(() => presetToCron({ kind: 'weekly', weekdays: [], hour: 1, minute: 0 })).toThrow(RangeError);
    expect(() => presetToCron({ kind: 'custom', expr: 'rm -rf /; echo' })).toThrow(RangeError);
  });

  it('every 时长解析与格式化', () => {
    expect(parseEveryDuration('10m')).toBe(600_000);
    expect(parseEveryDuration('2h')).toBe(7_200_000);
    expect(parseEveryDuration('10 minutes')).toBeNull();
    expect(formatEveryDuration(1_800_000)).toBe('30m');
    expect(formatEveryDuration(86_400_000)).toBe('1d');
  });
});

describe('buildCronArgs', () => {
  const base = {
    name: 'Daily report',
    message: 'Summarize yesterday\nin 3 bullets',
    agentId: 'writer',
    schedule: { mode: 'preset' as const, preset: { kind: 'daily' as const, hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  };

  it('新建：预设换算成 --cron，默认独立会话、不投递', () => {
    expect(buildCronArgs(base, 'add')).toEqual([
      '--name', 'Daily report',
      '--agent', 'writer',
      '--message', 'Summarize yesterday\nin 3 bullets',
      '--cron', '0 9 * * *', '--tz', 'Asia/Shanghai',
      '--session', 'isolated',
      '--no-deliver',
    ]);
  });

  it('编辑：空字段显式清除，启停转成 --enable/--disable', () => {
    const args = buildCronArgs({ ...base, agentId: '', enabled: false, delivery: { mode: 'announce', channel: 'telegram', to: '' } }, 'edit');
    expect(args).toContain('--clear-agent');
    expect(args).toContain('--clear-to');
    expect(args).toContain('--clear-model');
    expect(args).toContain('--disable');
    expect(args.slice(args.indexOf('--announce'), args.indexOf('--announce') + 3)).toEqual(['--announce', '--channel', 'telegram']);
  });

  it('非法输入抛 ControlInputError（带 errorCode）', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...base, name: '' }, 'cron.invalidName'],
      [{ ...base, name: 'a\nb' }, 'cron.invalidName'],
      [{ ...base, agentId: '../etc' }, 'cron.invalidAgent'],
      [{ ...base, schedule: { mode: 'every', every: 'soon' } }, 'cron.invalidSchedule'],
      [{ ...base, schedule: { mode: 'preset', preset: { kind: 'custom', expr: '$(id)' } } }, 'cron.invalidSchedule'],
      [{ ...base, delivery: { mode: 'announce', channel: 'Tele gram' } }, 'cron.invalidDelivery'],
      [{ ...base, schedule: { mode: 'preset', preset: base.schedule.preset, tz: 'Asia/Shanghai; rm' } }, 'cron.invalidTimezone'],
    ];
    for (const [input, code] of cases) {
      try {
        buildCronArgs(input as any, 'add');
        throw new Error(`expected ${code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ControlInputError);
        expect((error as ControlInputError).errorCode).toBe(code);
      }
    }
  });
});

describe('任务视图与版本号', () => {
  const raw = {
    id: 'job-1',
    agentId: 'main',
    name: 'demo',
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    schedule: { kind: 'cron', expr: '*/15 * * * *' },
    sessionTarget: 'isolated',
    payload: { kind: 'agentTurn', message: 'hello' },
    delivery: { mode: 'none', channel: 'last' },
    state: { nextRunAtMs: 100 },
    nextRunAtMs: 100,
  };

  it('运行状态变化不改版本号，配置变化改', () => {
    const ran = { ...raw, updatedAtMs: 99, state: { nextRunAtMs: 200, lastRunAtMs: 150, lastStatus: 'ok' }, nextRunAtMs: 200, status: 'idle' };
    expect(cronJobRevision(ran)).toBe(cronJobRevision(raw));
    expect(cronJobRevision({ ...raw, payload: { kind: 'agentTurn', message: 'changed' } })).not.toBe(cronJobRevision(raw));
  });

  it('归一化：认出预设、带出消息与投递', () => {
    const view = normalizeCronJob(raw);
    expect(view.schedule.preset).toEqual({ kind: 'everyMinutes', minutes: 15 });
    expect(view.message).toBe('hello');
    expect(view.delivery).toEqual({ mode: 'none', channel: 'last', to: null });
    expect(view.nextRunAtMs).toBe(100);
    const every = normalizeCronJob({ ...raw, schedule: { kind: 'every', everyMs: 1_800_000 } });
    expect(every.schedule).toMatchObject({ kind: 'every', every: '30m', preset: null });
  });

  it('服务按 CLI 真实输出形状解析列表，写操作标 mutating', async () => {
    const calls: Array<{ args: string[]; mutating?: boolean }> = [];
    const cli = {
      run: async (args: string[], options: { mutating?: boolean } = {}) => {
        calls.push({ args, mutating: options.mutating });
        return { stdout: '{"ok":true,"enqueued":true,"runId":"manual:job-1:1"}', stderr: '' };
      },
      runJson: async (args: string[], options: { mutating?: boolean } = {}) => {
        calls.push({ args, mutating: options.mutating });
        if (args[1] === 'list') return { jobs: [raw], total: 1 };
        return raw;
      },
    } as any;
    const service = createCronService({ openclawCli: cli });
    expect((await service.listJobs()).map((job) => job.id)).toEqual(['job-1']);
    expect(await service.runNow('job-1')).toEqual({ runId: 'manual:job-1:1', enqueued: true });
    await service.removeJob('job-1');
    expect(calls.find((call) => call.args[1] === 'list')?.mutating).toBeUndefined();
    expect(calls.filter((call) => ['run', 'rm'].includes(call.args[1])).every((call) => call.mutating === true)).toBe(true);
    await expect(service.removeJob('job 1; rm')).rejects.toBeInstanceOf(ControlInputError);
  });
});

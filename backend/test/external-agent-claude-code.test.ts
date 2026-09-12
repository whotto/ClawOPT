/**
 * Claude Code 适配器：命令构造与流解析。
 *
 * ## 为什么这一块可以先做，不等主机决策
 *
 * 三种主机方案（扩容现机 / 跨机调用 / Mac 上做原型）下，**要跑的命令和要解析的
 * 输出完全相同**，变的只是「谁去执行这条命令」。所以执行器是注入进来的，
 * 这两件事先落地不会返工。
 *
 * ## 下面每一条都来自真机实测（claude 2.1.269，2026-09-12），不是照文档抄
 *
 * 本仓库有过三次「代码看起来对、真机上是另一回事」：v1.3.0 的 runtime 键、
 * v1.3.2 读错凭据库、2026.8 的握手身份。所以这里的取值一律以实测为准：
 *
 * - `--output-format stream-json` 在 `--print` 下**强制要求 `--verbose`**，
 *   不加则运行前就报错退出（实测）。
 * - `--session-id` 接受**客户端自己生成的 UUID**，`--resume <同一 uuid>` 能续上
 *   （实测）。所以不需要「先调一次、捕获返回 id」那套往返。
 * - 不重定向 stdin 会固定罚 3 秒（实测 stderr：`no stdin data received in 3s`）。
 * - 真实事件流里除文档所列，还有 `system/hook_started`、`system/hook_response`、
 *   `rate_limit_event`，且**随本机 hook 配置而变**。解析器必须容忍未知类型。
 */
import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../src/external-agents/claude-code';

const adapter = new ClaudeCodeAdapter();

const req = (over: Partial<Parameters<typeof adapter.buildCommand>[0]> = {}) => ({
  sessionId: '1e2dae2d-eea3-4bee-8f7d-073833cdde12',
  prompt: '把这件事查清楚',
  workingDir: '/home/u/projects/app',
  resume: false,
  ...over,
});

describe('命令构造', () => {
  it('stream-json **必须**同时带 --verbose，否则 claude 运行前就退出', () => {
    const { args } = adapter.buildCommand(req());
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args, 'stream-json 不带 --verbose 会直接报错退出').toContain('--verbose');
  });

  it('首轮用 --session-id 带上客户端生成的 UUID，不用 --resume', () => {
    const { args } = adapter.buildCommand(req({ resume: false }));
    expect(args[args.indexOf('--session-id') + 1]).toBe('1e2dae2d-eea3-4bee-8f7d-073833cdde12');
    expect(args).not.toContain('--resume');
  });

  it('续话用 --resume 带同一个 UUID，不再传 --session-id', () => {
    const { args } = adapter.buildCommand(req({ resume: true }));
    expect(args[args.indexOf('--resume') + 1]).toBe('1e2dae2d-eea3-4bee-8f7d-073833cdde12');
    expect(args).not.toContain('--session-id');
  });

  it('stdin 明确走 /dev/null —— 不重定向每次白等 3 秒', () => {
    expect(adapter.buildCommand(req()).stdin).toBe('devnull');
  });

  it('总是带 --permission-prompts none：headless 下没人应答，就该拒绝', () => {
    const { args } = adapter.buildCommand(req());
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
  });

  it('**永远不出现绕过权限的开关**', () => {
    const { args } = adapter.buildCommand(req({
      allowedTools: ['Bash(git *)', 'Read'], maxBudgetUsd: 1, model: 'sonnet',
    }));
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    expect(args.join(' ')).not.toContain('bypassPermissions');
  });

  it('prompt 作为最后一个位置参数，不做 shell 转义（数组传参，不过 shell）', () => {
    const { args } = adapter.buildCommand(req({ prompt: '带 "引号" 和 $变量 的提示词' }));
    expect(args[args.length - 1]).toBe('带 "引号" 和 $变量 的提示词');
  });

  it('可选项按需出现，不给就不带', () => {
    const bare = adapter.buildCommand(req()).args;
    expect(bare).not.toContain('--model');
    expect(bare).not.toContain('--max-budget-usd');
    expect(bare).not.toContain('--append-system-prompt');
    expect(bare).not.toContain('--allowedTools');

    const full = adapter.buildCommand(req({
      model: 'claude-sonnet-5',
      maxBudgetUsd: 0.5,
      appendSystemPrompt: '你在一个团队频道里',
      allowedTools: ['Read', 'Bash(git *)'],
    })).args;
    expect(full[full.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    expect(full[full.indexOf('--max-budget-usd') + 1]).toBe('0.5');
    expect(full[full.indexOf('--append-system-prompt') + 1]).toBe('你在一个团队频道里');
    expect(full.slice(full.indexOf('--allowedTools') + 1, full.indexOf('--allowedTools') + 3))
      .toEqual(['Read', 'Bash(git *)']);
  });

  it('工作目录单独给出，由执行器负责 cwd，不拼进参数', () => {
    const built = adapter.buildCommand(req());
    expect(built.cwd).toBe('/home/u/projects/app');
  });
});

describe('流解析 —— 事件形状取自真机抓包', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('assistant 事件抽出文本增量', () => {
    const ev = adapter.parseStreamLine(line({
      type: 'assistant', session_id: 's',
      message: { content: [{ type: 'text', text: 'OK' }] },
    }));
    expect(ev?.kind).toBe('delta');
    expect(ev?.text).toBe('OK');
  });

  it('一条 assistant 里多个 text 块被拼起来', () => {
    const ev = adapter.parseStreamLine(line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
    }));
    expect(ev?.text).toBe('第一段第二段');
  });

  it('assistant 里的非文本块（tool_use）不当成正文', () => {
    const ev = adapter.parseStreamLine(line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    }));
    expect(ev?.kind).toBe('progress');
    expect(ev?.text).toBeFalsy();
  });

  it('result/success 给出最终文本、成本与 session', () => {
    const ev = adapter.parseStreamLine(line({
      type: 'result', subtype: 'success', is_error: false,
      result: '42', session_id: 'sid-1', total_cost_usd: 0.006736, duration_ms: 2248,
    }));
    expect(ev?.kind).toBe('final');
    expect(ev?.text).toBe('42');
    expect(ev?.sessionId).toBe('sid-1');
    expect(ev?.costUsd).toBeCloseTo(0.006736, 6);
  });

  it('is_error 为真时判为错误，哪怕 subtype 看着正常', () => {
    const ev = adapter.parseStreamLine(line({
      type: 'result', subtype: 'success', is_error: true, result: '炸了',
    }));
    expect(ev?.kind).toBe('error');
  });

  it('system/init 抽出漂移探针字段——不必再让模型自报身份', () => {
    const ev = adapter.parseStreamLine(line({
      type: 'system', subtype: 'init', model: 'claude-sonnet-5',
      claude_code_version: '2.1.269', apiKeySource: 'none', session_id: 'sid-1',
      cwd: '/private/tmp', tools: ['Bash', 'Read'],
    }));
    expect(ev?.kind).toBe('init');
    expect(ev?.model).toBe('claude-sonnet-5');
    expect(ev?.runtimeVersion).toBe('2.1.269');
  });

  it('**未知事件类型不抛错**——实测流里有 hook_started / hook_response / rate_limit_event，且随本机 hook 配置而变', () => {
    for (const raw of [
      { type: 'system', subtype: 'hook_started', hook_name: 'x' },
      { type: 'system', subtype: 'hook_response', exit_code: 0 },
      { type: 'rate_limit_event', rate_limit_info: {} },
      { type: '某个明年才会有的类型' },
    ]) {
      const ev = adapter.parseStreamLine(line(raw));
      expect(ev?.kind, `未知类型 ${JSON.stringify(raw).slice(0, 40)} 把解析器打挂了`).toBe('unknown');
    }
  });

  it('非 JSON 行与空行不抛错', () => {
    expect(() => adapter.parseStreamLine('not json at all')).not.toThrow();
    expect(adapter.parseStreamLine('')).toBeNull();
    expect(adapter.parseStreamLine('   ')).toBeNull();
  });

  it('hook_response 里的 stdout 不会被当成助手正文吐给用户', () => {
    // hook 的输出是本机的执行细节，可能含路径甚至凭据，它不属于对话。
    const ev = adapter.parseStreamLine(line({
      type: 'system', subtype: 'hook_response', stdout: '/Users/someone/.secret 里有东西',
    }));
    expect(ev?.kind).toBe('unknown');
    expect(ev?.text).toBeFalsy();
  });
});

/**
 * 长 prompt 走 stdin —— 借鉴 HKUDS/OpenOPC。
 *
 * 位置参数受 `ARG_MAX` 限制（Linux 上通常约 2 MB，且整个 argv + envp 共享这个上限）。
 * 群上下文一长——多成员、长历史、附件语境文本——就会撞上它，而症状是
 * `E2BIG`：进程根本起不来，看起来像「这个成员不说话」。
 *
 * 我在写契约表时把 `max_prompt_bytes` 标成「未知/待测」，因为没在真机上量过。
 * OpenOPC 的 `adapters/base.py` 给了现成答案：stdin 策略有四档，其中
 * `pipe_prompt_then_close`——把 prompt 从 stdin 喂进去然后**关闭**。
 * 关闭这一步是必须的：不关的话子进程会一直等更多输入。
 *
 * 阈值取得保守：远低于 ARG_MAX，但足够让绝大多数群消息仍走 argv（argv 更好排障，
 * `ps` 里看得见完整命令）。
 */
describe('prompt 传输通道', () => {
  it('短 prompt 仍走 argv —— ps 里看得见，好排障', () => {
    const built = adapter.buildCommand(req({ prompt: '短消息' }));
    expect(built.args[built.args.length - 1]).toBe('短消息');
    expect(built.stdin).toBe('devnull');
    expect(built.stdinData).toBeUndefined();
  });

  it('**超长 prompt 改走 stdin，并且不出现在 argv 里**', () => {
    const long = '很长的群上下文。'.repeat(20000);   // 远超阈值
    const built = adapter.buildCommand(req({ prompt: long }));

    expect(built.stdin, '长 prompt 仍走 argv，迟早撞 E2BIG').toBe('pipe');
    expect(built.stdinData).toBe(long);
    expect(built.args.join('\u0000'), 'prompt 同时出现在 argv 里，等于没绕开 ARG_MAX')
      .not.toContain(long.slice(0, 200));
  });

  it('走 stdin 时其余参数一个不少', () => {
    const long = 'x'.repeat(300000);
    const built = adapter.buildCommand(req({ prompt: long, model: 'claude-sonnet-5' }));
    expect(built.args).toContain('--verbose');
    expect(built.args).toContain('--session-id');
    expect(built.args[built.args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('阈值按**字节**算，不按字符数——中文一个字三字节', () => {
    // 20 万个中文字 = 60 万字节。按字符数判会以为还没到阈值。
    const cjk = '群'.repeat(200000);
    expect(Buffer.byteLength(cjk, 'utf-8')).toBeGreaterThan(cjk.length);
    expect(adapter.buildCommand(req({ prompt: cjk })).stdin).toBe('pipe');
  });
});


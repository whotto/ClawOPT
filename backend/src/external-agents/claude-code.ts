/**
 * Claude Code 适配器。
 *
 * 每一个取值都来自真机实测（`claude` 2.1.269，2026-09-12），不是照文档抄——
 * 本仓库有过三次「代码看起来对、真机上是另一回事」（v1.3.0 的 runtime 键、
 * v1.3.2 读错凭据库、2026.8 的握手身份），所以这里的规矩是：没跑过的不写进来。
 */
import type {
  BuiltCommand,
  ExternalAgentAdapter,
  ExternalRunEvent,
  ExternalRunRequest,
} from './types';

export class ClaudeCodeAdapter implements ExternalAgentAdapter {
  readonly runtime = 'claude-code';

  buildCommand(request: ExternalRunRequest): BuiltCommand {
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      // `--verbose` 不是可选项：实测 `--print` 下用 stream-json 而不带它，
      // claude 在**运行前**就报错退出（Error: When using --print,
      // --output-format=stream-json requires --verbose）。
      '--verbose',
      // headless 下没有人能应答权限询问。`none` = 凡是会弹窗的一律拒绝，
      // 权限模式仍然照常生效。不给这个参数，等于把决定权交给一个不存在的人。
      '--permission-prompts', 'none',
    ];

    // 续话与开新会话是互斥的两条路。
    // 实测：`--session-id` 接受**客户端自己生成的 UUID**，之后 `--resume <同一 uuid>`
    // 能续上。所以不需要「先调一次、捕获返回的 id、再存映射表」那套往返，
    // 也就没有「首次调用失败时映射表处于半写状态」这个竞态。
    if (request.resume) {
      args.push('--resume', request.sessionId);
    } else {
      args.push('--session-id', request.sessionId);
    }

    if (request.model) args.push('--model', request.model);

    // 群上下文用 append 而不是 --system-prompt：后者会把对方自己的项目指令
    // （CLAUDE.md / AGENTS.md）整个顶掉，那就等于把它变成一个普通模型，
    // 路线 B 的意义正是让它以自己的身份干活。
    if (request.appendSystemPrompt) args.push('--append-system-prompt', request.appendSystemPrompt);

    if (request.allowedTools?.length) args.push('--allowedTools', ...request.allowedTools);
    for (const dir of request.extraDirs ?? []) args.push('--add-dir', dir);

    if (typeof request.maxBudgetUsd === 'number') {
      args.push('--max-budget-usd', String(request.maxBudgetUsd));
    }

    // prompt 放最后一个位置参数。命令走数组传参、不过 shell，所以引号、`$`、
    // 反引号都不需要转义。（已知边界：位置参数受 ARG_MAX 限制，极长的 prompt
    // 需要改走 stdin —— 那条路还没在真机上量过，不写进来。）
    args.push(request.prompt);

    return {
      command: 'claude',
      args,
      cwd: request.workingDir,
      // 见 types.ts：不重定向 stdin，每次固定罚 3 秒。
      stdin: 'devnull',
    };
  }

  parseStreamLine(line: string): ExternalRunEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // 流里混进非 JSON 行（启动噪声、被截断的一行）不该让整轮对话失败。
      return { kind: 'unknown', raw: trimmed };
    }
    if (!event || typeof event !== 'object') return { kind: 'unknown', raw: event };

    if (event.type === 'assistant') {
      const blocks: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
      const text = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      // 只有工具调用、没有正文的那一帧是过程信号，不是正文。
      // 把它当正文吐出去，用户会看到空白气泡闪一下。
      return text
        ? { kind: 'delta', text, sessionId: event.session_id, raw: event }
        : { kind: 'progress', sessionId: event.session_id, raw: event };
    }

    if (event.type === 'result') {
      // is_error 优先于 subtype：实测 subtype 仍是 success 而 is_error 为真是可能的，
      // 只看 subtype 会把一次失败当成成功交付出去。
      const failed = event.is_error === true || event.subtype !== 'success';
      return {
        kind: failed ? 'error' : 'final',
        text: typeof event.result === 'string' ? event.result : undefined,
        sessionId: event.session_id,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
        detail: failed ? String(event.subtype ?? 'error') : undefined,
        raw: event,
      };
    }

    if (event.type === 'system' && event.subtype === 'init') {
      // 这就是版本漂移探针：模型、CLI 版本、凭据来源都在这一帧里，
      // 不必再花一次调用去问「你是哪个模型」。
      return {
        kind: 'init',
        model: typeof event.model === 'string' ? event.model : undefined,
        runtimeVersion: typeof event.claude_code_version === 'string' ? event.claude_code_version : undefined,
        sessionId: event.session_id,
        raw: event,
      };
    }

    // 其余一律 unknown，**不抛**。实测流里有 system/hook_started、
    // system/hook_response、rate_limit_event，而且随本机 hook 配置而变；
    // 上游随时可能再加新类型。
    //
    // 注意这一档**不带 text**：hook_response 里有 stdout/stderr，那是本机执行
    // 细节（可能含路径甚至凭据），不属于对话，不能顺手当正文吐给用户。
    return { kind: 'unknown', sessionId: event.session_id, raw: event };
  }
}

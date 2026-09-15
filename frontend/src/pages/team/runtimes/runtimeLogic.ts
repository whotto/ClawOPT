// 运行时管理页的类型与纯函数（带单测）：卡片上显示哪些按钮、诊断提示词怎么拼、错误怎么说人话。

export type UpdateState = 'unknown' | 'checking' | 'current' | 'available' | 'waiting' | 'updating' | 'failed';

export type RuntimeOperationRecord = {
  op: 'install' | 'update' | 'uninstall' | 'check';
  ok: boolean;
  messageCode: string | null;
  command: string | null;
  output: string;
  finishedAt: string;
};

export type RuntimeStatus = {
  id: string;
  name: string;
  vendor: string | null;
  kind: 'cli' | 'remote';
  installKind: 'npm' | 'pip' | 'manual';
  installed: boolean;
  version: string | null;
  path: string | null;
  candidates: string[];
  source: 'npm-global' | 'managed-venv' | 'external' | null;
  managed: boolean;
  probeError: string | null;
  probedAt: string;
  update: { state: UpdateState; currentVersion: string | null; latestVersion: string | null; checkedAt: string | null; error: string | null };
  autoUpdate: boolean;
  locked: boolean;
  preparing: number;
  adapterRegistered: boolean;
  lastOperation: RuntimeOperationRecord | null;
};

export type HostCapabilities = {
  platform: string;
  arch: string;
  node: string;
  memory: { totalMb: number; freeMb: number };
  modules: { nodePty: boolean; sharp: boolean };
  tools: { git: string | null; npm: string | null; pnpm: string | null; uv: string | null; python3: string | null };
  gates: Record<'runtimeInstall' | 'pipRuntimes' | 'terminal', { allowed: boolean; reason: string | null }>;
};

export type ApiError = { errorCode?: string; errorDetail?: string | null; errorParams?: Record<string, unknown> | null; operation?: RuntimeOperationRecord };

export type ErrorDisplay = { message: string; detail: string };

export type RuntimeCardAction ='install' | 'update' | 'checkUpdate' | 'uninstall' | 'settings';

/** 卡片上的按钮：按状态与能力推，不按运行时名字写 if。 */
export function runtimeCardActions(status: RuntimeStatus, host: HostCapabilities | null): { actions: RuntimeCardAction[]; installBlockedReason: string | null } {
  const actions: RuntimeCardAction[] = [];
  let installBlockedReason: string | null = null;
  if (status.kind === 'remote') return { actions: [], installBlockedReason };
  if (host && !host.gates.runtimeInstall.allowed) installBlockedReason = host.gates.runtimeInstall.reason;
  if (host && status.installKind === 'pip' && !host.gates.pipRuntimes.allowed) installBlockedReason = host.gates.pipRuntimes.reason;
  if (!status.installed) {
    if (status.installKind !== 'manual') actions.push('install');
  } else if (status.managed) {
    actions.push(status.update.state === 'available' || status.update.state === 'waiting' ? 'update' : 'checkUpdate');
    actions.push('uninstall');
  } else {
    actions.push('checkUpdate');
  }
  actions.push('settings');
  return { actions, installBlockedReason };
}

/** 失败时交给「让 AI 诊断」的提示词：结构化、不含任何凭据（输出在服务端已脱敏）。 */
export function buildDiagnosePrompt(input: {
  status: RuntimeStatus;
  operation: RuntimeOperationRecord | null;
  errorMessage: string;
  host: HostCapabilities | null;
  locale: string;
}): string {
  const { status, operation, host } = input;
  const zh = input.locale.startsWith('zh');
  const lines = zh
    ? [
      `请帮我排查 ClawOPT 外部运行时「${status.name}」（${status.id}）的问题。`,
      '',
      '## 现场',
      `- 操作：${operation?.op ?? '（无）'}`,
      `- 结果：${input.errorMessage}`,
      `- 命令：${operation?.command ?? '（无）'}`,
      `- 安装方式：${status.installKind}；来源：${status.source ?? '未安装'}；ClawOPT 代管：${status.managed ? '是' : '否'}`,
      `- 已装版本：${status.version ?? '无'}；可执行文件：${status.path ?? '无'}`,
    ]
    : [
      `Please help me troubleshoot the ClawOPT external runtime "${status.name}" (${status.id}).`,
      '',
      '## Context',
      `- Operation: ${operation?.op ?? '(none)'}`,
      `- Result: ${input.errorMessage}`,
      `- Command: ${operation?.command ?? '(none)'}`,
      `- Install kind: ${status.installKind}; source: ${status.source ?? 'not installed'}; managed by ClawOPT: ${status.managed ? 'yes' : 'no'}`,
      `- Installed version: ${status.version ?? 'none'}; executable: ${status.path ?? 'none'}`,
    ];
  if (host) {
    lines.push(zh
      ? `- 主机：${host.platform}/${host.arch}，Node ${host.node}，可用内存 ${host.memory.freeMb} MB / ${host.memory.totalMb} MB，npm ${host.tools.npm ?? '无'}，uv ${host.tools.uv ?? '无'}，python3 ${host.tools.python3 ?? '无'}`
      : `- Host: ${host.platform}/${host.arch}, Node ${host.node}, free memory ${host.memory.freeMb} MB / ${host.memory.totalMb} MB, npm ${host.tools.npm ?? 'none'}, uv ${host.tools.uv ?? 'none'}, python3 ${host.tools.python3 ?? 'none'}`);
  }
  if (operation?.output) {
    lines.push('', zh ? '## 输出（已脱敏）' : '## Output (redacted)', '```', operation.output, '```');
  }
  lines.push('', zh
    ? '请先判断根因（网络 / 权限 / Node 或 Python 环境 / 包名 / 冲突的安装），再给出可以直接执行的修复步骤。不要让我把任何密钥贴出来。'
    : 'Identify the root cause first (network / permissions / Node or Python environment / package name / conflicting installs), then give fix steps I can run directly. Do not ask me to paste any secret.');
  return lines.join('\n');
}

/** 结构化错误 → 界面文案：优先翻译 errorCode，翻不出来退回详情。 */
export function resolveApiErrorMessage(data: ApiError | null | undefined, t: (key: string, options?: any) => string, fallbackKey: string): { message: string; detail: string } {
  const code = data?.errorCode;
  const translated = code ? t(code, (data?.errorParams ?? {}) as any) : '';
  const message = translated && translated !== code ? translated : (code || t(fallbackKey));
  return { message, detail: typeof data?.errorDetail === 'string' ? data.errorDetail : '' };
}

export function parseRuntimeQuery(search: string): { runtimeId: string | null; section: 'settings' | 'mcp' | 'skills' } {
  const params = new URLSearchParams(search);
  const runtimeId = params.get('runtime');
  const section = params.get('section');
  return {
    runtimeId: runtimeId && /^[a-z0-9][a-z0-9-]{0,63}$/.test(runtimeId) ? runtimeId : null,
    section: section === 'mcp' || section === 'skills' ? section : 'settings',
  };
}

export type DiagnoseAgent = { id: string; name: string };

/** 某个运行时的诊断单聊固定用一个 id：同一个运行时反复点「让 AI 诊断」复用同一个会话（已存在时创建会报 idAlreadyExists）。 */
export function diagnoseSessionId(runtime: string): string {
  return `diagnose-${runtime}`;
}

/** 诊断目标：`runtime:<id>` = 新开 / 复用该运行时的诊断单聊；其余是已有会话的 id。 */
export function pickDiagnoseTarget(target: string, agents: DiagnoseAgent[]): { sessionId: string; createRuntime: string | null } {
  if (target.startsWith('runtime:')) {
    const runtime = target.slice('runtime:'.length);
    const sessionId = diagnoseSessionId(runtime);
    return { sessionId, createRuntime: agents.some((agent) => agent.id === sessionId) ? null : runtime };
  }
  return { sessionId: target, createRuntime: null };
}

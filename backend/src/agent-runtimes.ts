/**
 * Agent 运行时（agent runtime）—— 一个 Agent 的「模型循环由谁来跑」。
 *
 * ## 这不是模型，也不是 provider
 *
 * OpenClaw 2026.8 把这几层分开了（见它自带的 `docs/concepts/agent-runtimes.md`）：
 *
 * | 层 | 例子 | 含义 |
 * |---|---|---|
 * | Provider | `anthropic` / `openai` / `deepseek` | 怎么认证、怎么发现模型 |
 * | Model | `deepseek-v4-flash` | 这一轮用哪个模型 |
 * | **Agent runtime** | `openclaw` / `claude` / `gemini` | **谁来执行这一轮** |
 *
 * ClawOPT 此前只有前两层的界面，所以在引擎升级到 2026.8 之后，
 * 「把一个 Agent 接成 Claude Code」这件事在界面上无从表达——
 * 实测：ClawOPT 建出来的 entries 里没有 `runtime` 字段。
 *
 * ## 为什么这里只列 5 个，而 acpx 支持 18 个
 *
 * acpx 内置 18 个别名（claude / codex / copilot / cursor / droid / fast-agent /
 * gemini / iflow / kilocode / kimi / kiro / mux / opencode / openclaw / pi /
 * qoder / qwen / trae）。这里只暴露**用户点名要的那几个**，理由与
 * `external-agents/service.ts` 的 CATALOG 一致：
 * **列出来就等于承诺它能用**，而每一个都需要它自己的账号与首次下载，
 * 没验过的不该出现在下拉框里。
 *
 * 加一个的成本是这个数组里加一行 —— 不是五处代码。
 */

/** 运行时选项。`openclaw` 是默认，即引擎自己跑。 */
export const AGENT_RUNTIMES = [
  {
    id: 'openclaw',
    /** 界面文案的 i18n key 后缀，三份 locale 里都要有 `sidebar.agentRuntime.<id>`。 */
    labelKey: 'openclaw',
    /** 走 ACP/acpx 还是引擎内置。 */
    kind: 'native',
    /** 这个运行时需要什么账号——界面上要如实告诉用户，别让他建完才发现用不了。 */
    requires: null,
  },
  {
    id: 'claude',
    labelKey: 'claude',
    kind: 'acp',
    requires: 'anthropic',
  },
  {
    id: 'gemini',
    labelKey: 'gemini',
    kind: 'acp',
    requires: 'google',
  },
  {
    id: 'opencode',
    labelKey: 'opencode',
    kind: 'acp',
    requires: 'opencode',
  },
  {
    id: 'pi',
    labelKey: 'pi',
    kind: 'acp',
    requires: 'pi',
  },
  {
    id: 'codex',
    labelKey: 'codex',
    /**
     * Codex 有两条路，这里走的是 **ACP 那条**。
     *
     * 引擎自带文档明说「除非明确需要 ACP，否则优先原生」——原生那条是把模型 ref
     * 设成 `openai/*`，不需要在这里选运行时。所以选了 `codex` 的用户是**显式**
     * 要 ACP 路径的，界面文案要说清楚这个区别，否则他会以为这是唯一的接法。
     */
    kind: 'acp',
    requires: 'openai',
  },
] as const;

export type AgentRuntimeId = (typeof AGENT_RUNTIMES)[number]['id'];

export const DEFAULT_AGENT_RUNTIME: AgentRuntimeId = 'openclaw';

const RUNTIME_IDS = new Set<string>(AGENT_RUNTIMES.map((r) => r.id));

/**
 * 归一化用户传来的值。**认不出来就退回默认，并让调用方知道**——
 * 静默接受一个不认识的 id 会写进 `openclaw.json`，而引擎读到未知别名时
 * 的行为我们没验过。朝已知的方向失败。
 */
export function normalizeAgentRuntime(value: unknown): { id: AgentRuntimeId; recognized: boolean } {
  if (typeof value === 'string' && RUNTIME_IDS.has(value)) {
    return { id: value as AgentRuntimeId, recognized: true };
  }
  return { id: DEFAULT_AGENT_RUNTIME, recognized: value === undefined || value === null };
}

/**
 * 把运行时选择翻译成名册条目里的 `runtime` 字段。
 *
 * 返回 `undefined` 表示「不写这个字段」——`openclaw` 是引擎默认，
 * 显式写一个 `type: 'openclaw'` 进去等于给用户的配置加一行噪声，
 * 而且一旦上游改了默认值的名字，那行就成了错的。**默认不落盘。**
 */
export function buildRuntimeConfig(
  runtimeId: AgentRuntimeId,
  cwd: string,
): { type: 'acp'; acp: { agent: string; cwd: string } } | undefined {
  if (runtimeId === DEFAULT_AGENT_RUNTIME) return undefined;
  return { type: 'acp', acp: { agent: runtimeId, cwd } };
}

/** 从名册条目反推运行时 id，供界面回显。读不出就是默认。 */
export function readAgentRuntimeFromEntry(entry: unknown): AgentRuntimeId {
  if (!entry || typeof entry !== 'object') return DEFAULT_AGENT_RUNTIME;
  const runtime = (entry as Record<string, unknown>).runtime;
  if (!runtime || typeof runtime !== 'object') return DEFAULT_AGENT_RUNTIME;
  const r = runtime as Record<string, unknown>;
  if (r.type !== 'acp') return DEFAULT_AGENT_RUNTIME;
  const acp = r.acp;
  if (!acp || typeof acp !== 'object') return DEFAULT_AGENT_RUNTIME;
  return normalizeAgentRuntime((acp as Record<string, unknown>).agent).id;
}

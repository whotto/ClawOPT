/**
 * MCP 服务器管理：`openclaw mcp list/show/status/set/unset/probe/reload/tools`。
 *
 * ## 凭据只出不进
 *
 * MCP 配置的 `env` 与 `headers` 里常放 API key、Bearer token。JSON 编辑器又必须拿到整份配置才能改，
 * 所以读出时把这两处的**值**换成占位符 `KEEP_SECRET`，写回时占位符再换回磁盘上的原值。
 * 占位符只在「同名键原来就有值」时生效；新键写占位符按非法输入拒绝，免得把字面量占位符存进引擎。
 */
import { computeRevision } from '../../core/http';
import type { OpenClawCliRunner } from '../../openclaw';
import { ControlInputError, requireString } from '../shared/control-http';

export const MCP_SECRET_PLACEHOLDER = '__clawopt_keep_secret__';
const SECRET_BEARING_KEYS = ['env', 'headers'] as const;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_CONFIG_BYTES = 64 * 1024;

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);

export function assertMcpName(name: unknown): string {
  return requireString(name, 'mcp.invalidName', { pattern: NAME_PATTERN });
}

/** 出：env / headers 的值换成占位符（空串保持空串，便于看出「配了但为空」）。 */
export function redactMcpConfig(config: Raw): Raw {
  const out: Raw = { ...config };
  for (const key of SECRET_BEARING_KEYS) {
    if (!isObject(config[key])) continue;
    out[key] = Object.fromEntries(Object.entries(config[key] as Raw).map(([name, value]) => [name, value === '' ? '' : MCP_SECRET_PLACEHOLDER]));
  }
  return out;
}

/** 进：占位符换回原值；原来没有这个键却写了占位符 → 拒绝。 */
export function restoreMcpSecrets(next: Raw, current: Raw | null): Raw {
  const out: Raw = { ...next };
  for (const key of SECRET_BEARING_KEYS) {
    if (out[key] === undefined) continue;
    if (!isObject(out[key])) throw new ControlInputError('mcp.invalidConfig');
    const previous = isObject(current?.[key]) ? current![key] as Raw : {};
    out[key] = Object.fromEntries(Object.entries(out[key] as Raw).map(([name, value]) => {
      if (value !== MCP_SECRET_PLACEHOLDER) {
        if (typeof value !== 'string') throw new ControlInputError('mcp.invalidConfig');
        return [name, value];
      }
      if (typeof previous[name] !== 'string') throw new ControlInputError('mcp.placeholderWithoutValue', 400, { key: name });
      return [name, previous[name]];
    }));
  }
  return out;
}

export function validateMcpConfig(config: unknown): Raw {
  if (!isObject(config)) throw new ControlInputError('mcp.invalidConfig');
  const hasCommand = typeof config.command === 'string' && config.command.trim() !== '';
  const hasUrl = typeof config.url === 'string' && config.url.trim() !== '';
  if (!hasCommand && !hasUrl) throw new ControlInputError('mcp.commandOrUrlRequired');
  if (hasUrl) {
    let parsed: URL;
    try {
      parsed = new URL(String(config.url));
    } catch {
      throw new ControlInputError('mcp.invalidUrl');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ControlInputError('mcp.invalidUrl');
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) {
    throw new ControlInputError('mcp.invalidConfig');
  }
  if (Buffer.byteLength(JSON.stringify(config)) > MAX_CONFIG_BYTES) throw new ControlInputError('mcp.configTooLarge');
  return config;
}

export type McpServerView = {
  name: string;
  config: Raw;
  transport: string | null;
  enabled: boolean;
  ok: boolean | null;
  launch: string | null;
  revision: string;
};

export function createMcpService(deps: { openclawCli: OpenClawCliRunner }) {
  const cli = deps.openclawCli;

  async function readAll(): Promise<Raw> {
    const raw = await cli.runJson<unknown>(['mcp', 'list', '--json']);
    return isObject(raw) ? raw : {};
  }

  async function list(): Promise<McpServerView[]> {
    const [servers, status] = await Promise.all([
      readAll(),
      cli.runJson<Raw>(['mcp', 'status', '--json']).catch(() => ({} as Raw)),
    ]);
    const statusByName = new Map<string, Raw>();
    for (const entry of Array.isArray(status.servers) ? status.servers : []) {
      if (isObject(entry) && typeof entry.name === 'string') statusByName.set(entry.name, entry);
    }
    return Object.entries(servers)
      .filter(([, config]) => isObject(config))
      .map(([name, config]) => {
        const state = statusByName.get(name) ?? {};
        return {
          name,
          config: redactMcpConfig(config as Raw),
          transport: typeof state.transport === 'string' ? state.transport : null,
          enabled: (config as Raw).enabled !== false && state.enabled !== false,
          ok: typeof state.ok === 'boolean' ? state.ok : null,
          launch: typeof state.launch === 'string' ? redactLaunch(state.launch) : null,
          revision: computeRevision(config),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getRaw(name: string): Promise<Raw | null> {
    const all = await readAll();
    const config = all[assertMcpName(name)];
    return isObject(config) ? config : null;
  }

  /** 保存（新建或覆盖）。`current` 由路由在版本校验后传入，用来还原占位符。 */
  async function save(name: string, config: unknown, current: Raw | null): Promise<void> {
    const safeName = assertMcpName(name);
    const restored = restoreMcpSecrets(validateMcpConfig(config), current);
    const secrets = SECRET_BEARING_KEYS.flatMap((key) => (isObject(restored[key]) ? Object.values(restored[key] as Raw).filter((v): v is string => typeof v === 'string') : []));
    await cli.run(['mcp', 'set', safeName, JSON.stringify(restored)], { mutating: true, secrets });
  }

  async function remove(name: string): Promise<void> {
    await cli.run(['mcp', 'unset', assertMcpName(name)], { mutating: true });
  }

  async function probe(name: string): Promise<Raw> {
    return cli.runJson<Raw>(['mcp', 'probe', assertMcpName(name), '--json'], { timeoutMs: 90_000 });
  }

  async function reload(): Promise<void> {
    await cli.run(['mcp', 'reload'], { mutating: true });
  }

  async function setToolFilter(name: string, filter: { mode: 'all' | 'include' | 'exclude'; tools: string[] }): Promise<void> {
    const safeName = assertMcpName(name);
    if (filter.mode === 'all') {
      await cli.run(['mcp', 'tools', safeName, '--clear'], { mutating: true });
      return;
    }
    if (filter.mode !== 'include' && filter.mode !== 'exclude') throw new ControlInputError('mcp.invalidToolFilter');
    const tools = (Array.isArray(filter.tools) ? filter.tools : [])
      .map((tool) => (typeof tool === 'string' ? tool.trim() : ''))
      .filter((tool) => /^[A-Za-z0-9_.*:-]{1,128}$/.test(tool));
    if (tools.length === 0) throw new ControlInputError('mcp.invalidToolFilter');
    await cli.run(['mcp', 'tools', safeName, `--${filter.mode}`, tools.join(',')], { mutating: true });
  }

  return { list, getRaw, save, remove, probe, reload, setToolFilter };
}

/** `launch` 是拼好的命令行，可能带 `--api-key xxx` 之类的参数：只留可执行名与参数个数。 */
function redactLaunch(launch: string): string {
  const parts = launch.trim().split(/\s+/);
  return parts.length <= 1 ? parts[0] ?? '' : `${parts[0]} …(${parts.length - 1})`;
}

export type McpService = ReturnType<typeof createMcpService>;

/**
 * 插件清单：`openclaw plugins list/inspect/enable/disable/install/uninstall/update`。
 *
 * 安装只接受包规格（npm 规格、`clawhub:` 包、https git 地址），**不接受本机路径**——
 * 从 Web 端让引擎去装服务器上任意一个目录，等于给了一个「把磁盘上的代码加载进网关」的入口。
 * 本机路径安装仍可在终端用 CLI 做。
 */
import { redactLogValue } from '../../core/logger';
import type { OpenClawCliRunner } from '../../openclaw';
import { ControlInputError, requireString } from '../shared/control-http';

type Raw = Record<string, unknown>;

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/_.:-]{0,127}$/;
const NPM_SPEC_PATTERN = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9._^~<>=*-]+)?$/;
const CLAWHUB_SPEC_PATTERN = /^clawhub:[A-Za-z0-9@][A-Za-z0-9@/_.-]{0,127}$/;
const GIT_SPEC_PATTERN = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+(\.git)?(#[A-Za-z0-9_./-]+)?$/;

const LIST_CACHE_TTL_MS = 15_000;

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export type PluginView = {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  format: string | null;
  origin: string | null;
  enabled: boolean;
  status: string | null;
  toolCount: number;
  hookCount: number;
  channelIds: string[];
  providerIds: string[];
  commandCount: number;
  dependenciesMissing: string[];
};

export function normalizePlugin(raw: Raw): PluginView {
  const deps = (raw.dependencyStatus && typeof raw.dependencyStatus === 'object' ? raw.dependencyStatus : {}) as Raw;
  return {
    id: String(raw.id ?? ''),
    name: str(raw.name) ?? String(raw.id ?? ''),
    description: str(raw.description),
    version: str(raw.version),
    format: str(raw.format),
    origin: str(raw.origin),
    enabled: raw.enabled === true,
    status: str(raw.status),
    toolCount: arr(raw.toolNames).length,
    hookCount: typeof raw.hookCount === 'number' ? raw.hookCount : arr(raw.hookNames).length,
    channelIds: arr(raw.channelIds).filter((v): v is string => typeof v === 'string'),
    providerIds: arr(raw.providerIds).filter((v): v is string => typeof v === 'string'),
    commandCount: arr(raw.commands).length + arr(raw.cliCommands).length,
    dependenciesMissing: arr(deps.missing).filter((v): v is string => typeof v === 'string'),
  };
}

export function assertInstallSpec(spec: unknown): string {
  const text = requireString(spec, 'plugins.invalidSpec', { max: 300 });
  if (text.startsWith('/') || text.startsWith('.') || text.startsWith('~') || text.includes('..')) {
    throw new ControlInputError('plugins.localPathNotAllowed');
  }
  if (NPM_SPEC_PATTERN.test(text) || CLAWHUB_SPEC_PATTERN.test(text) || GIT_SPEC_PATTERN.test(text)) return text;
  throw new ControlInputError('plugins.invalidSpec');
}

export function assertPluginId(id: unknown): string {
  return requireString(id, 'plugins.invalidId', { pattern: PLUGIN_ID_PATTERN });
}

export function createPluginsService(deps: { openclawCli: OpenClawCliRunner; now?: () => number }) {
  const cli = deps.openclawCli;
  const now = deps.now ?? Date.now;
  let cache: { at: number; value: { plugins: PluginView[]; diagnostics: unknown[] } } | null = null;

  async function list(options: { fresh?: boolean } = {}) {
    if (!options.fresh && cache && now() - cache.at < LIST_CACHE_TTL_MS) return cache.value;
    const raw = await cli.runJson<Raw>(['plugins', 'list', '--json'], { timeoutMs: 60_000 });
    const plugins = arr(raw.plugins)
      .filter((entry): entry is Raw => !!entry && typeof entry === 'object')
      .map(normalizePlugin)
      .filter((plugin) => plugin.id)
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id));
    const value = { plugins, diagnostics: redactLogValue(arr(raw.diagnostics).slice(0, 50)) as unknown[] };
    cache = { at: now(), value };
    return value;
  }

  async function inspect(id: string) {
    const raw = await cli.runJson<Raw>(['plugins', 'inspect', assertPluginId(id), '--json'], { timeoutMs: 60_000 });
    const plugin = (raw.plugin && typeof raw.plugin === 'object' ? raw.plugin : raw) as Raw;
    // 详情里有安装路径（含用户名）与 syntheticAuthRefs 之类的键，统一过日志层脱敏再出去。
    return redactLogValue({
      ...normalizePlugin(plugin),
      activationReason: str(plugin.activationReason),
      toolNames: arr(plugin.toolNames),
      hookNames: arr(plugin.hookNames),
      commands: arr(plugin.commands),
      services: arr(plugin.services),
      source: str(plugin.source),
      rootDir: str(plugin.rootDir),
    });
  }

  async function mutate(args: string[], timeoutMs = 60_000) {
    await cli.run(args, { mutating: true, timeoutMs });
    cache = null;
  }

  return {
    list,
    inspect,
    enable: (id: string) => mutate(['plugins', 'enable', assertPluginId(id)]),
    disable: (id: string) => mutate(['plugins', 'disable', assertPluginId(id)]),
    install: (spec: string, options: { acknowledgeRisk?: boolean } = {}) => mutate(
      ['plugins', 'install', assertInstallSpec(spec), ...(options.acknowledgeRisk ? ['--acknowledge-clawhub-risk'] : [])],
      5 * 60_000,
    ),
    uninstall: (id: string) => mutate(['plugins', 'uninstall', assertPluginId(id), '--force'], 2 * 60_000),
    update: (id: string | null) => mutate(['plugins', 'update', ...(id ? [assertPluginId(id)] : ['--all'])], 5 * 60_000),
  };
}

export type PluginsService = ReturnType<typeof createPluginsService>;

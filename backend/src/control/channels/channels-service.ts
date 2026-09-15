/**
 * 频道：`openclaw channels list/status/capabilities/add/remove/login/logout` + 清空凭据。
 *
 * ## 凭据只进不出
 *
 * - 列表与状态里凡是键名像凭据的字段（token / secret / password / key / serviceAccount…），
 *   值一律换成 `hasXxx: true/false`，不回原值。
 * - 添加 / 更新时凭据字段留空 = 不修改（不传给 CLI），与设置页的纪律一致。
 * - **清空凭据** 不走 `channels remove --delete`（那会连允许名单、@ 提及规则一起删掉），
 *   而是读出 `channels.<id>` 配置，找出键名像凭据的路径逐个 `config unset`——行为设置原样保留。
 */
import { type OpenClawCliRunner, redactCliText } from '../../openclaw';
import { ControlInputError, optionalString, requireString } from '../shared/control-http';

type Raw = Record<string, unknown>;

const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,63}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CREDENTIAL_KEY_PATTERN = /(token|secret|password|passwd|apikey|api_key|serviceaccount|privatekey|private_key|encryptkey|signingkey|cookie|credential)/i;

const isObject = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);

/** 递归把凭据形状的键换成 `hasXxx` 布尔位。 */
export function redactChannelCredentials(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.map((item) => redactChannelCredentials(item, depth + 1));
  if (!isObject(value)) return value;
  const out: Raw = {};
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      out[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = item !== null && item !== undefined && item !== '';
      continue;
    }
    out[key] = redactChannelCredentials(item, depth + 1);
  }
  return out;
}

/** 在 `channels.<id>` 配置里找出凭据形状的叶子路径（相对 `channels.<id>`）。 */
export function findCredentialPaths(config: unknown, prefix: string[] = [], depth = 0): string[][] {
  if (!isObject(config) || depth > 4) return [];
  const out: string[][] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!PATH_SEGMENT_PATTERN.test(key)) continue;
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      if (value !== undefined && value !== null && value !== '') out.push([...prefix, key]);
      continue;
    }
    if (isObject(value)) out.push(...findCredentialPaths(value, [...prefix, key], depth + 1));
  }
  return out;
}

export function assertChannel(channel: unknown): string {
  return requireString(channel, 'channels.invalidChannel', { pattern: CHANNEL_PATTERN });
}

function accountArgs(account: unknown): string[] {
  const id = optionalString(account, 'channels.invalidAccount', { pattern: ACCOUNT_PATTERN });
  return id ? ['--account', id] : [];
}

export type ChannelAddInput = {
  channel: string;
  account?: string | null;
  name?: string | null;
  botToken?: string;
  appToken?: string;
  password?: string;
  secret?: string;
  baseUrl?: string | null;
  httpUrl?: string | null;
  useEnv?: boolean;
};

const SECRET_FLAGS: Array<[keyof ChannelAddInput, string]> = [
  ['botToken', '--bot-token'],
  ['appToken', '--app-token'],
  ['password', '--password'],
  ['secret', '--secret'],
];

export function buildChannelAddArgs(input: ChannelAddInput): { args: string[]; secrets: string[] } {
  const args = ['channels', 'add', '--channel', assertChannel(input?.channel), ...accountArgs(input.account)];
  const name = optionalString(input.name, 'channels.invalidName', { max: 100 });
  if (name) args.push('--name', name);
  const secrets: string[] = [];
  for (const [field, flag] of SECRET_FLAGS) {
    const value = input[field];
    if (typeof value !== 'string' || value === '') continue; // 留空 = 不修改
    if (/[\r\n\0]/.test(value) || value.length > 4096) throw new ControlInputError('channels.invalidCredential');
    args.push(flag, value);
    secrets.push(value);
  }
  for (const [field, flag] of [['baseUrl', '--base-url'], ['httpUrl', '--http-url']] as const) {
    const url = optionalString(input[field], 'channels.invalidUrl', { max: 500 });
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ControlInputError('channels.invalidUrl');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ControlInputError('channels.invalidUrl');
    args.push(flag, url);
  }
  if (input.useEnv === true) args.push('--use-env');
  return { args, secrets };
}

export function createChannelsService(deps: { openclawCli: OpenClawCliRunner }) {
  const cli = deps.openclawCli;

  async function list(options: { all?: boolean } = {}) {
    const raw = await cli.runJson<Raw>(['channels', 'list', '--json', ...(options.all ? ['--all'] : [])]);
    const chat = isObject(raw.chat) ? raw.chat : {};
    const channels = Object.entries(chat).map(([id, entry]) => {
      const record = isObject(entry) ? entry : {};
      return {
        id,
        installed: record.installed !== false,
        origin: typeof record.origin === 'string' ? record.origin : null,
        accounts: (Array.isArray(record.accounts) ? record.accounts : []).map((account) => redactChannelCredentials(account)),
      };
    });
    return { channels };
  }

  async function status(options: { probe?: boolean } = {}) {
    const raw = await cli.runJson<Raw>(
      ['channels', 'status', '--json', ...(options.probe ? ['--probe'] : [])],
      { timeoutMs: options.probe ? 60_000 : 30_000 },
    );
    return redactChannelCredentials({
      channelOrder: raw.channelOrder ?? [],
      channelLabels: raw.channelLabels ?? {},
      channels: raw.channels ?? {},
      channelAccounts: raw.channelAccounts ?? {},
    });
  }

  async function capabilities(channel: string, account?: unknown) {
    const raw = await cli.runJson<Raw>(['channels', 'capabilities', '--channel', assertChannel(channel), ...accountArgs(account), '--json'], { timeoutMs: 30_000 });
    return redactChannelCredentials(raw);
  }

  async function add(input: ChannelAddInput) {
    const { args, secrets } = buildChannelAddArgs(input);
    await cli.run(args, { mutating: true, secrets, timeoutMs: 60_000 });
  }

  async function remove(channel: string, account: unknown, deleteConfig: boolean) {
    await cli.run(['channels', 'remove', '--channel', assertChannel(channel), ...accountArgs(account), ...(deleteConfig ? ['--delete'] : [])], { mutating: true });
  }

  async function logout(channel: string, account: unknown) {
    await cli.run(['channels', 'logout', '--channel', assertChannel(channel), ...accountArgs(account)], { mutating: true, timeoutMs: 60_000 });
  }

  /** 非交互式登录：能直接完成的频道会完成；需要扫码的频道把（脱敏后的）输出带回给界面提示。 */
  async function login(channel: string, account: unknown) {
    const { stdout } = await cli.run(['channels', 'login', '--channel', assertChannel(channel), ...accountArgs(account)], { mutating: true, timeoutMs: 120_000 });
    return { output: redactCliText(stdout) };
  }

  /** 清空凭据、保留行为设置。返回被清掉的路径（相对 `channels.<id>`），界面照实展示。 */
  async function clearCredentials(channel: string) {
    const id = assertChannel(channel);
    let config: unknown;
    try {
      config = await cli.runJson(['config', 'get', `channels.${id}`, '--json']);
    } catch (error) {
      // 引擎里没有这个频道的配置段：没有可清的凭据。
      if ((error as { errorCode?: string }).errorCode === 'openclaw.notFound') {
        return { cleared: [] as string[] };
      }
      throw error;
    }
    const paths = findCredentialPaths(config);
    for (const segments of paths) {
      await cli.run(['config', 'unset', ['channels', id, ...segments].join('.')], { mutating: true });
    }
    return { cleared: paths.map((segments) => segments.join('.')) };
  }

  return { list, status, capabilities, add, remove, logout, login, clearCredentials };
}

export type ChannelsService = ReturnType<typeof createChannelsService>;

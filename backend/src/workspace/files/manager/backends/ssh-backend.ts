/**
 * SSH 后端：系统 `ssh` CLI，参数数组，**主机密钥校验永远开着**。
 *
 * 参考实现用 `StrictHostKeyChecking=no`（spec 07 §3.2 第 10 条），这里反过来：
 * - 固定 `-F /dev/null`（不读用户 ~/.ssh/config——那里的 `StrictHostKeyChecking no` 会被继承）、
 *   `StrictHostKeyChecking=yes`、`UserKnownHostsFile=<ClawOPT 数据目录>/file-manager/known_hosts`、
 *   `GlobalKnownHostsFile=/dev/null`、`BatchMode=yes`（不弹口令）；
 * - 这些选项**不从连接配置里读**，连接配置里也没有能改它们的字段；未知主机只能经界面「扫描 → 核对指纹 → 确认」进 known_hosts；
 * - 主机、用户名按白名单字符校验，以 `-` 开头一律拒绝（`-oProxyCommand=…` 这类参数注入），主机前还有 `--`。
 */
import { fmError } from '../file-manager-errors';
import { openLocalReadStream } from '../file-manager-fs';
import {
  mapRemoteFailure,
  parseRemoteEntries,
  remoteShellArgv,
  shellQuote,
  spawnRemoteRunner,
  spawnRemoteStreamer,
  type RemoteOp,
  type RemoteRunner,
  type RemoteStreamer,
  type TransportCommand,
} from './remote-shell';
import type { FileBackend } from './types';

export type SshConnectionConfig = {
  host: string;
  port: number;
  user: string;
  /** 远端根目录（绝对路径）。 */
  rootPath: string;
  /** 私钥文件的本机路径；null 用 ssh-agent / 默认身份。 */
  keyPath: string | null;
};

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$|^\[[0-9A-Fa-f:.]+\]$|^[0-9A-Fa-f:]+$/;
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export function validateSshHost(host: unknown): string {
  if (typeof host !== 'string') throw fmError.invalidInput('host');
  const value = host.trim();
  if (!value || value.startsWith('-') || !HOST_PATTERN.test(value)) throw fmError.invalidInput('host');
  return value;
}

export function validateSshUser(user: unknown): string {
  if (typeof user !== 'string' || !USER_PATTERN.test(user.trim())) throw fmError.invalidInput('user');
  return user.trim();
}

export function validateSshPort(port: unknown): number {
  const value = port === undefined || port === null || port === '' ? 22 : Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw fmError.invalidInput('port');
  return value;
}

export function validateRemoteRoot(rootPath: unknown): string {
  if (typeof rootPath !== 'string') throw fmError.invalidInput('rootPath');
  const value = rootPath.trim();
  if (!value.startsWith('/') || value.includes('\0') || /[\r\n]/.test(value) || value.split('/').includes('..')) throw fmError.invalidInput('rootPath');
  if (value === '/') throw fmError.invalidInput('rootPath');
  return value;
}

/** 固定的连接选项。**不接受任何覆盖**：守卫用例断言它们总在、且没有 `StrictHostKeyChecking=no`。 */
export function sshBaseOptions(knownHostsFile: string): string[] {
  return [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
  ];
}

export function buildSshCommand(config: SshConnectionConfig, knownHostsFile: string, remoteArgv: string[]): TransportCommand {
  const host = validateSshHost(config.host);
  const user = validateSshUser(config.user);
  const port = validateSshPort(config.port);
  const args = [...sshBaseOptions(knownHostsFile), '-p', String(port), '-l', user];
  if (config.keyPath) args.push('-i', config.keyPath, '-o', 'IdentitiesOnly=yes');
  args.push('--', host.replace(/^\[(.*)\]$/, '$1'), remoteArgv.map(shellQuote).join(' '));
  return { command: 'ssh', args };
}

export function createSshBackend(config: SshConnectionConfig, options: { knownHostsFile: string; runner?: RemoteRunner; streamer?: RemoteStreamer }): FileBackend {
  const runner = options.runner ?? spawnRemoteRunner;
  const streamer = options.streamer ?? spawnRemoteStreamer;
  const root = validateRemoteRoot(config.rootPath);
  const command = (op: RemoteOp, args: string[]) => buildSshCommand(config, options.knownHostsFile, remoteShellArgv(op, root, args));
  return createRemoteBackend('ssh', command, runner, streamer);
}

/** SSH 与 Docker 共用的操作实现：只差「怎么把 sh 参数数组送到远端」。 */
export function createRemoteBackend(
  kind: 'ssh' | 'docker',
  command: (op: RemoteOp, args: string[]) => TransportCommand,
  runner: RemoteRunner,
  streamer: RemoteStreamer,
): FileBackend {
  const run = async (op: RemoteOp, args: string[], stdin?: Parameters<RemoteRunner>[1]['stdin'], maxOutputBytes?: number) => {
    const result = await runner(command(op, args), { stdin, maxOutputBytes });
    if (result.spawnError || result.timedOut || result.code !== 0) throw mapRemoteFailure(result, kind);
    return result.stdout;
  };
  return {
    kind,
    async list(relDir) {
      return parseRemoteEntries((await run('list', [relDir])).toString('utf8'), relDir);
    },
    async stat(relPath) {
      const [entry] = parseRemoteEntries((await run('stat', [relPath])).toString('utf8'), '');
      if (!entry) throw fmError.notFound();
      return { ...entry, path: relPath, name: relPath.split('/').pop() ?? '' };
    },
    async read(relPath, maxBytes) {
      try {
        return await run('read', [relPath, String(maxBytes)], null, maxBytes + 1);
      } catch (error) {
        if ((error as { errorCode?: string }).errorCode === 'fileManager.tooLarge') throw fmError.tooLarge(maxBytes);
        throw error;
      }
    },
    async write(relPath, data) {
      await run('write', [relPath, '1'], data);
    },
    async writeFromLocalFile(relPath, localFile, writeOptions) {
      await run('write', [relPath, writeOptions.overwrite ? '1' : '0'], openLocalReadStream(localFile));
    },
    async mkdir(relPath) {
      await run('mkdir', [relPath]);
    },
    async rename(fromRel, toRel) {
      await run('rename', [fromRel, toRel]);
    },
    async copy(fromRel, toRel) {
      await run('copy', [fromRel, toRel]);
    },
    async remove(relPath, removeOptions) {
      await run('remove', [relPath, removeOptions.recursive ? '1' : '0']);
    },
    async openReadStream(relPath, maxBytes) {
      const size = Number((await run('size', [relPath])).toString('utf8').trim());
      if (!Number.isFinite(size)) throw fmError.backendError(null);
      if (size > maxBytes) throw fmError.tooLarge(maxBytes);
      const readCommand = command('read', [relPath, String(maxBytes)]);
      const handle = streamer(readCommand);
      return { stream: handle.stdout, size };
    },
    async localRealPath() {
      return null;
    },
  };
}

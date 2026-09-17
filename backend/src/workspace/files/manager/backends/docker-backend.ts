/**
 * Docker 后端：`docker exec -i <容器> sh -c <固定脚本> sh <op> <根> <路径>…`，参数数组原样到达，不经 shell。
 * 只有主机上有 docker CLI 时才可用（主机能力闸门 `fileManagerDocker`）。
 */
import { fmError } from '../file-manager-errors';
import { remoteShellArgv, spawnRemoteRunner, spawnRemoteStreamer, type RemoteOp, type RemoteRunner, type RemoteStreamer, type TransportCommand } from './remote-shell';
import { createRemoteBackend, validateRemoteRoot } from './ssh-backend';
import type { FileBackend } from './types';

export type DockerConnectionConfig = { container: string; rootPath: string };

const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function validateContainer(container: unknown): string {
  if (typeof container !== 'string' || !CONTAINER_PATTERN.test(container.trim())) throw fmError.invalidInput('container');
  return container.trim();
}

export function buildDockerCommand(config: DockerConnectionConfig, remoteArgv: string[]): TransportCommand {
  return { command: 'docker', args: ['exec', '-i', validateContainer(config.container), ...remoteArgv] };
}

export function createDockerBackend(config: DockerConnectionConfig, options: { runner?: RemoteRunner; streamer?: RemoteStreamer } = {}): FileBackend {
  const root = validateRemoteRoot(config.rootPath);
  const command = (op: RemoteOp, args: string[]) => buildDockerCommand(config, remoteShellArgv(op, root, args));
  return createRemoteBackend('docker', command, options.runner ?? spawnRemoteRunner, options.streamer ?? spawnRemoteStreamer);
}

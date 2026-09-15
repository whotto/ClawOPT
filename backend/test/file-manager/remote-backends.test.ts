/**
 * 远端后端：SSH 命令构造（主机密钥校验永远开着、参数注入挡住）、Docker 参数数组、退出码映射、
 * known_hosts 扫描 → 核对 → 确认，以及**远端脚本本身**在本机 sh 上真跑（软链逃逸、敏感路径之外的包含判定）。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDockerCommand, createDockerBackend } from '../../src/workspace/files/manager/backends/docker-backend';
import { mapRemoteFailure, remoteShellArgv, shellQuote, spawnRemoteRunner, spawnRemoteStreamer, type RemoteRunner } from '../../src/workspace/files/manager/backends/remote-shell';
import { buildSshCommand, createSshBackend, sshBaseOptions, validateSshHost } from '../../src/workspace/files/manager/backends/ssh-backend';
import { createKnownHosts, fingerprintOf, hostPatternFor, parseKnownHostsLine } from '../../src/workspace/files/manager/known-hosts';

const KNOWN_HOSTS = '/data/file-manager/known_hosts';
const config = { host: 'example.com', port: 22, user: 'deploy', rootPath: '/srv/app', keyPath: null };

describe('SSH 命令构造', () => {
  it('永远带 StrictHostKeyChecking=yes、ClawOPT 自己的 known_hosts、BatchMode、不读用户 ssh 配置；绝不出现 =no', () => {
    const command = buildSshCommand(config, KNOWN_HOSTS, ['sh', '-c', 'echo', 'sh', 'list', '/srv/app', '']);
    expect(command.command).toBe('ssh');
    const joined = command.args.join(' ');
    expect(joined).toContain('-o StrictHostKeyChecking=yes');
    expect(joined).toContain(`-o UserKnownHostsFile=${KNOWN_HOSTS}`);
    expect(joined).toContain('-o BatchMode=yes');
    expect(joined).toContain('-F /dev/null');
    expect(joined).toContain('-o GlobalKnownHostsFile=/dev/null');
    expect(joined).not.toMatch(/StrictHostKeyChecking=(no|accept-new|off)/i);
    // 主机前有 `--`，远端命令是最后一个参数（一个字符串）。
    expect(command.args.slice(-3, -1)).toEqual(['--', 'example.com']);
  });

  it('连接配置里塞「关掉校验」的字段不生效：选项表不读配置', () => {
    const sneaky = { ...config, strictHostKeyChecking: 'no', options: ['StrictHostKeyChecking=no'], host: 'example.com' } as any;
    const command = buildSshCommand(sneaky, KNOWN_HOSTS, ['true']);
    expect(command.args.join(' ')).not.toMatch(/StrictHostKeyChecking=no/i);
    expect(sshBaseOptions(KNOWN_HOSTS)).toContain('StrictHostKeyChecking=yes');
  });

  it('参数注入：以 `-` 开头或带空格 / 引号 / 分号的主机与用户名一律拒绝', () => {
    for (const host of ['-oProxyCommand=touch /tmp/pwn', '-p', 'a b', 'x;id', "x'y", '', 'host/../x']) {
      expect(() => validateSshHost(host), host).toThrow(/invalidInput/);
    }
    expect(() => buildSshCommand({ ...config, user: '-oProxyCommand=x' }, KNOWN_HOSTS, ['true'])).toThrow(/invalidInput/);
    expect(() => buildSshCommand({ ...config, host: '-oProxyCommand=x' }, KNOWN_HOSTS, ['true'])).toThrow(/invalidInput/);
  });

  it('远端命令里的每个参数都单引号转义：路径里的引号、$()、分号原样到达远端 sh', () => {
    const tricky = "a'b $(id); `x`";
    const command = buildSshCommand(config, KNOWN_HOSTS, remoteShellArgv('read', '/srv/app', [tricky, '10']));
    const remote = command.args[command.args.length - 1];
    // 本机 sh 解析这串远端命令，参数应当原样还原。
    const echoed = spawnSync('sh', ['-c', remote.replace(/^'sh' '-c' '(?:[^']|'\\'')*' 'sh'/, "printf '%s\\n'")], { encoding: 'utf8' });
    expect(echoed.stdout.split('\n')).toEqual(['read', '/srv/app', tricky, '10', '']);
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('Docker 与退出码映射', () => {
  it('docker exec 参数数组，容器名校验', () => {
    const command = buildDockerCommand({ container: 'app_1', rootPath: '/srv' }, ['sh', '-c', 'x']);
    expect(command).toEqual({ command: 'docker', args: ['exec', '-i', 'app_1', 'sh', '-c', 'x'] });
    expect(() => buildDockerCommand({ container: '-it', rootPath: '/srv' }, [])).toThrow(/invalidInput/);
  });

  it('退出码 → fileManager.*；ssh 主机密钥失败单独认；执行不了按主机能力说明', () => {
    const base = { stdout: Buffer.alloc(0), timedOut: false, spawnError: null };
    expect(mapRemoteFailure({ ...base, code: 81, stderr: '' }, 'ssh').errorCode).toBe('fileManager.outsideRoot');
    expect(mapRemoteFailure({ ...base, code: 82, stderr: '' }, 'docker').errorCode).toBe('fileManager.notFound');
    expect(mapRemoteFailure({ ...base, code: 255, stderr: 'Host key verification failed.\r\n' }, 'ssh').errorCode).toBe('fileManager.hostKeyUnknown');
    expect(mapRemoteFailure({ ...base, code: 255, stderr: 'No ED25519 host key is known for x' }, 'ssh').errorCode).toBe('fileManager.hostKeyUnknown');
    const missing = mapRemoteFailure({ ...base, code: null, stderr: '', spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }, 'docker');
    expect(missing.errorCode).toBe('fileManager.backendUnavailable');
    expect(missing.extra).toEqual({ reasonCode: 'host.dockerMissing' });
  });

  it('远端后端经注入的执行器：命令里带 StrictHostKeyChecking=yes，列表解析', async () => {
    const seen: string[][] = [];
    const runner: RemoteRunner = async (command) => {
      seen.push(command.args);
      return { code: 0, stdout: Buffer.from('d\t0\t1700000000\tdocs\nf\t12\t1700000001\tREADME.md\n'), stderr: '', timedOut: false, spawnError: null };
    };
    const backend = createSshBackend(config, { knownHostsFile: KNOWN_HOSTS, runner });
    const entries = await backend.list('');
    expect(entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([['docs', 'dir', 0], ['README.md', 'file', 12]]);
    expect(seen[0]).toContain('StrictHostKeyChecking=yes');
  });
});

describe('远端脚本在本机 sh 上真跑（包含判定）', () => {
  let base: string;
  let root: string;
  // 用本机 sh 当「容器」：把 docker exec -i <容器> 去掉，剩下的参数数组原样执行。
  const localRunner: RemoteRunner = (command, options) => spawnRemoteRunner({ command: command.args[3], args: command.args.slice(4) }, options);
  const localStreamer = (command: { command: string; args: string[] }) => spawnRemoteStreamer({ command: command.args[3], args: command.args.slice(4) });

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-fm-remote-')));
    root = path.join(base, 'root');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'hello');
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'escape'));
    fs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(root, 'link.txt'));
  });

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  const backend = () => createDockerBackend({ container: 'local', rootPath: root }, { runner: localRunner, streamer: localStreamer });

  it('列、读、写、改名、复制、删除', async () => {
    const b = backend();
    expect((await b.list('docs')).map((entry) => entry.name)).toEqual(['a.txt']);
    expect((await b.read('docs/a.txt', 1024)).toString()).toBe('hello');
    await b.write('docs/b.txt', Buffer.from('bee'));
    expect(fs.readFileSync(path.join(root, 'docs', 'b.txt'), 'utf8')).toBe('bee');
    await b.rename('docs/b.txt', 'docs/c.txt');
    await b.copy('docs/c.txt', 'docs/d.txt');
    await b.mkdir('new');
    await expect(b.mkdir('new')).rejects.toMatchObject({ errorCode: 'fileManager.alreadyExists' });
    await b.remove('docs/d.txt', { recursive: false });
    expect(fs.readdirSync(path.join(root, 'docs')).sort()).toEqual(['a.txt', 'c.txt']);
    await expect(b.read('docs/a.txt', 2)).rejects.toMatchObject({ errorCode: 'fileManager.tooLarge' });
  });

  it('经软链读根外文件、往根外目录写、列根外目录：一律 outsideRoot', async () => {
    const b = backend();
    await expect(b.read('link.txt', 1024)).rejects.toMatchObject({ errorCode: 'fileManager.outsideRoot' });
    await expect(b.read('escape/secret.txt', 1024)).rejects.toMatchObject({ errorCode: 'fileManager.outsideRoot' });
    await expect(b.list('escape')).rejects.toMatchObject({ errorCode: 'fileManager.outsideRoot' });
    await expect(b.write('escape/planted.txt', Buffer.from('x'))).rejects.toMatchObject({ errorCode: 'fileManager.outsideRoot' });
    expect(fs.existsSync(path.join(base, 'outside', 'planted.txt'))).toBe(false);
    await expect(b.copy('escape', 'stolen')).rejects.toMatchObject({ errorCode: 'fileManager.outsideRoot' });
  });
});

describe('known_hosts 管理', () => {
  let dir: string;
  const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-fm-kh-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('扫描 → 指纹 → 只确认扫描拿到的行；非 22 端口写成 [host]:port；可删除', async () => {
    const calls: string[][] = [];
    const file = path.join(dir, 'known_hosts');
    const hosts = createKnownHosts({
      file,
      runner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: `# comment\n[example.com]:2222 ssh-ed25519 ${KEY}\n`, stderr: '', missing: false };
      },
    });
    const scan = await hosts.scan({ host: 'example.com', port: 2222 });
    expect(calls[0]).toEqual(['-T', '5', '-p', '2222', '--', 'example.com']);
    expect(scan.keys).toEqual([{ hostPattern: '[example.com]:2222', keyType: 'ssh-ed25519', fingerprint: fingerprintOf(KEY) }]);
    expect(fingerprintOf(KEY)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await expect(hosts.trust({ scanId: scan.scanId, fingerprints: ['SHA256:not-this-one'] })).rejects.toMatchObject({ errorCode: 'fileManager.invalidInput' });
    await expect(hosts.trust({ scanId: 'forged', fingerprints: [fingerprintOf(KEY)] })).rejects.toMatchObject({ errorCode: 'fileManager.invalidInput' });
    const trusted = await hosts.trust({ scanId: scan.scanId, fingerprints: [fingerprintOf(KEY)] });
    expect(trusted.map((entry) => entry.hostPattern)).toEqual(['[example.com]:2222']);
    expect(fs.readFileSync(file, 'utf8')).toBe(`[example.com]:2222 ssh-ed25519 ${KEY}\n`);
    await expect(hosts.scan({ host: '-oProxyCommand=x', port: 22 })).rejects.toMatchObject({ errorCode: 'fileManager.invalidInput' });
    expect(await hosts.remove({ hostPattern: '[example.com]:2222', fingerprint: fingerprintOf(KEY) })).toEqual([]);
    expect(hostPatternFor('h', 22)).toBe('h');
    expect(parseKnownHostsLine('@cert-authority * ssh-ed25519 AAAA')).toBeNull();
  });
});

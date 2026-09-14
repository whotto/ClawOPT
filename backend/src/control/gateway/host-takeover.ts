import path from 'path';
import os from 'os';
import fs from 'fs';

import {
  GATEWAY_HOST_TAKEOVER_CREDENTIALS_REQUIRED_ERROR_CODE,
  GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
  GATEWAY_HOST_TAKEOVER_SERVICE_NOT_FOUND_ERROR_CODE,
  StructuredRequestError,
} from '../../core/http';
import { appRepoRoot } from '../../core/paths';
import { execFilePromise, execFileWithInput, readCliErrorDetail } from '../../core/process';
import { normalizeCliText, shellQuote } from '../../core/util';
import {
  OPENCLAW_GATEWAY_SERVICE_NAME,
  type OpenClawExecPreflightBypassStatus,
  readOpenClawExecPreflightBypassStatus,
} from '../../openclaw';
import { buildManagedDocumentToolingInstruction } from '../../workspace';
import { readMaxPermissionsEnabled } from './max-permissions';

type HostTakeoverMode =
  | 'disabled'
  | 'ready'
  | 'needs_install'
  | 'broken';

type HostTakeoverAutoInstallMode =
  | 'root'
  | 'sudo'
  | 'pkexec'
  | 'manual';

type HostTakeoverStatus = {
  enabled: boolean;
  mode: HostTakeoverMode;
  ready: boolean;
  helperInstalled: boolean;
  helperReachable: boolean;
  servicePathPatched: boolean;
  execPreflightBypassReady: boolean;
  execPreflightTargetCount: number;
  execPreflightPatchedCount: number;
  currentUser: string;
  wrapperDir: string;
  hostRootPath: string;
  helperPath: string;
  autoInstallSupported: boolean;
  autoInstallMode: HostTakeoverAutoInstallMode;
  manualInstallCommand: string | null;
  rawDetail: string | null;
};
const HOST_TAKEOVER_SYSTEM_HELPER_PATH = '/usr/local/lib/openclaw-host-takeover/run';
const HOST_TAKEOVER_WRAPPER_DIR = path.join(os.homedir(), '.openclaw', 'host-takeover', 'bin');
const HOST_TAKEOVER_HOST_ROOT_PATH = path.join(HOST_TAKEOVER_WRAPPER_DIR, 'host-root');
const HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user',
  `${OPENCLAW_GATEWAY_SERVICE_NAME}.d`,
  '90-host-takeover.conf'
);
const HOST_TAKEOVER_INSTALLER_SCRIPT_PATH = path.join(appRepoRoot, 'backend', 'scripts', 'install-host-takeover.sh');

type HostTakeoverOverrideSnapshot = {
  existed: boolean;
  content: string | null;
};

function getCurrentUserName() {
  const envUser = normalizeCliText(process.env.USER);
  if (envUser) return envUser;
  try {
    return normalizeCliText(os.userInfo().username) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getHostTakeoverSudoersPath(userName = getCurrentUserName()) {
  return `/etc/sudoers.d/openclaw-host-takeover-${userName}`;
}

function buildHostTakeoverManualInstallCommand(userName = getCurrentUserName()) {
  if (!fs.existsSync(HOST_TAKEOVER_INSTALLER_SCRIPT_PATH)) {
    return null;
  }

  return [
    'sudo',
    '/bin/bash',
    shellQuote(HOST_TAKEOVER_INSTALLER_SCRIPT_PATH),
    '--user',
    shellQuote(userName),
    '--helper-path',
    shellQuote(HOST_TAKEOVER_SYSTEM_HELPER_PATH),
    '--sudoers-path',
    shellQuote(getHostTakeoverSudoersPath(userName)),
  ].join(' ');
}

function getHostTakeoverAutoInstallMode(): HostTakeoverAutoInstallMode {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return 'root';
  }
  if (fs.existsSync('/usr/bin/sudo')) {
    return 'sudo';
  }
  return 'manual';
}

function isHostTakeoverAutoInstallSupported() {
  return getHostTakeoverAutoInstallMode() !== 'manual';
}

function needsSudoPassword(detail: string) {
  const normalized = normalizeCliText(detail).toLowerCase();
  const sudoPromptDetected = normalized.includes('sudo:') || normalized.includes('sudo：') || normalized.includes('[sudo]');
  const passwordPromptDetected = normalized.includes('password')
    || normalized.includes('密码')
    || normalized.includes('口令')
    || normalized.includes('passphrase');
  const terminalPromptDetected = normalized.includes('terminal') || normalized.includes('终端');
  const authPromptDetected = normalized.includes('authentication') || normalized.includes('认证');

  return normalized.includes('password is required')
    || normalized.includes('a terminal is required')
    || normalized.includes('no askpass program specified')
    || normalized.includes('authentication is required')
    || normalized.includes('需要密码')
    || normalized.includes('需要提供密码')
    || normalized.includes('需要输入密码')
    || normalized.includes('密码是必需的')
    || normalized.includes('必须输入密码')
    || normalized.includes('需要口令')
    || normalized.includes('需要终端')
    || normalized.includes('需要认证')
    || (sudoPromptDetected && passwordPromptDetected)
    || (sudoPromptDetected && terminalPromptDetected)
    || (sudoPromptDetected && authPromptDetected);
}

function normalizePathEntries(pathValue: string | null | undefined) {
  return (pathValue || '')
    .split(':')
    .map((entry) => normalizeCliText(entry))
    .filter(Boolean);
}

function prependPathEntry(pathValue: string, entry: string) {
  return [entry, ...normalizePathEntries(pathValue).filter((item) => item !== entry)].join(':');
}

export function snapshotHostTakeoverOverride(): HostTakeoverOverrideSnapshot {
  if (!fs.existsSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH)) {
    return {
      existed: false,
      content: null,
    };
  }

  return {
    existed: true,
    content: fs.readFileSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, 'utf-8'),
  };
}

export function restoreHostTakeoverOverride(snapshot: HostTakeoverOverrideSnapshot) {
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, snapshot.content || '');
    return;
  }

  fs.rmSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, { force: true });
}

function buildHostTakeoverHostRootScript() {
  return `#!/bin/bash
set -euo pipefail

HELPER_PATH=${shellQuote(HOST_TAKEOVER_SYSTEM_HELPER_PATH)}

die() {
  echo "$1" >&2
  exit 126
}

target_user=""
if [[ "\${1:-}" == "--as-user" ]]; then
  shift
  target_user="\${1:-}"
  if [[ -z "$target_user" ]]; then
    echo "Missing user after --as-user" >&2
    exit 64
  fi
  shift
fi

if [[ "\${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: host-root [--as-user USER] -- <command> [args...]" >&2
  exit 64
fi

if [[ "$(id -u)" -eq 0 ]]; then
  if [[ -n "$target_user" && "$target_user" != "root" ]]; then
    if command -v runuser >/dev/null 2>&1; then
      exec runuser -u "$target_user" -- "$@"
    fi
    exec su -s /bin/sh "$target_user" -c "$(printf '%q ' "$@")"
  fi
  exec "$@"
fi

if [[ ! -x /usr/bin/sudo ]]; then
  die "OpenClaw host takeover requires /usr/bin/sudo on the host."
fi

if [[ -x "$HELPER_PATH" ]]; then
  if [[ -n "$target_user" && "$target_user" != "root" ]]; then
    exec /usr/bin/sudo -n "$HELPER_PATH" --as-user "$target_user" -- "$@"
  fi
  exec /usr/bin/sudo -n "$HELPER_PATH" "$@"
fi

if [[ -n "$target_user" && "$target_user" != "root" ]]; then
  exec /usr/bin/sudo -n -u "$target_user" -- "$@"
fi

exec /usr/bin/sudo -n -- "$@"
`;
}

function buildHostTakeoverSudoScript() {
  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
orig=("$@")
target_user=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|-H|-E|-k|-S)
      shift
      ;;
    -u)
      shift
      target_user="\${1:-}"
      if [[ -z "$target_user" ]]; then
        echo "Missing user after -u" >&2
        exit 64
      fi
      shift
      ;;
    -u*)
      target_user="\${1#-u}"
      if [[ -z "$target_user" ]]; then
        echo "Missing user after -u" >&2
        exit 64
      fi
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      exec /usr/bin/sudo -n "\${orig[@]}"
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  if [[ -n "$target_user" && "$target_user" != "root" ]]; then
    exec "$WRAPPER_DIR/host-root" --as-user "$target_user" -- /bin/sh
  fi
  exec "$WRAPPER_DIR/host-root" /bin/sh
fi

if [[ -n "$target_user" && "$target_user" != "root" ]]; then
  exec "$WRAPPER_DIR/host-root" --as-user "$target_user" -- "$@"
fi

exec "$WRAPPER_DIR/host-root" "$@"
`;
}

function buildHostTakeoverRootCommandScript(
  commandName: string,
  candidatePaths: string[],
  options?: { bypassUserFlag?: string }
) {
  const candidateLines = candidatePaths
    .map((candidate) => candidate)
    .join('\n');
  const bypassBlock = options?.bypassUserFlag
    ? `
for arg in "$@"; do
  if [[ "$arg" == ${shellQuote(options.bypassUserFlag)} ]]; then
    exec "$target" "$@"
  fi
done
`
    : '';

  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
target=""
while IFS= read -r candidate; do
  if [[ -x "$candidate" ]]; then
    target="$candidate"
    break
  fi
done <<'EOF'
${candidateLines}
EOF

if [[ -z "$target" ]]; then
  echo "OpenClaw host takeover could not find ${commandName} on this host." >&2
  exit 127
fi
${bypassBlock}
exec "$WRAPPER_DIR/host-root" "$target" "$@"
`;
}

function buildHostTakeoverPipScript(preferredCommand: 'pip' | 'pip3') {
  const primaryPath = preferredCommand === 'pip3' ? '/usr/bin/pip3' : '/usr/bin/pip';
  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
target=""
if [[ -x ${shellQuote(primaryPath)} ]]; then
  target=${shellQuote(primaryPath)}
elif [[ -x /usr/bin/python3 ]]; then
  exec "$WRAPPER_DIR/host-root" /usr/bin/python3 -m pip "$@"
else
  echo "OpenClaw host takeover could not find ${preferredCommand} or python3 on this host." >&2
  exit 127
fi

exec "$WRAPPER_DIR/host-root" "$target" "$@"
`;
}

function buildHostTakeoverPythonScript(commandName: 'python' | 'python3') {
  const candidates = commandName === 'python'
    ? ['/usr/bin/python', '/usr/bin/python3']
    : ['/usr/bin/python3', '/usr/local/bin/python3'];
  const candidateLines = candidates
    .map((candidate) => candidate)
    .join('\n');

  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
target=""
while IFS= read -r candidate; do
  if [[ -x "$candidate" ]]; then
    target="$candidate"
    break
  fi
done <<'EOF'
${candidateLines}
EOF

if [[ -z "$target" ]]; then
  echo "OpenClaw host takeover could not find ${commandName} on this host." >&2
  exit 127
fi

if [[ "\${1:-}" == "-m" && ( "\${2:-}" == "pip" || "\${2:-}" == "ensurepip" ) ]]; then
  exec "$WRAPPER_DIR/host-root" "$target" "$@"
fi

exec "$target" "$@"
`;
}

export function ensureHostTakeoverWrappers() {
  fs.mkdirSync(HOST_TAKEOVER_WRAPPER_DIR, { recursive: true });

  const scripts = new Map<string, string>([
    ['host-root', buildHostTakeoverHostRootScript()],
    ['sudo', buildHostTakeoverSudoScript()],
    ['apt', buildHostTakeoverRootCommandScript('apt', ['/usr/bin/apt'])],
    ['apt-get', buildHostTakeoverRootCommandScript('apt-get', ['/usr/bin/apt-get'])],
    ['apt-cache', buildHostTakeoverRootCommandScript('apt-cache', ['/usr/bin/apt-cache'])],
    ['dpkg', buildHostTakeoverRootCommandScript('dpkg', ['/usr/bin/dpkg'])],
    ['dnf', buildHostTakeoverRootCommandScript('dnf', ['/usr/bin/dnf'])],
    ['yum', buildHostTakeoverRootCommandScript('yum', ['/usr/bin/yum'])],
    ['pacman', buildHostTakeoverRootCommandScript('pacman', ['/usr/bin/pacman'])],
    ['apk', buildHostTakeoverRootCommandScript('apk', ['/sbin/apk', '/usr/sbin/apk'])],
    ['zypper', buildHostTakeoverRootCommandScript('zypper', ['/usr/bin/zypper'])],
    ['rpm', buildHostTakeoverRootCommandScript('rpm', ['/usr/bin/rpm'])],
    ['snap', buildHostTakeoverRootCommandScript('snap', ['/usr/bin/snap'])],
    ['flatpak', buildHostTakeoverRootCommandScript('flatpak', ['/usr/bin/flatpak'])],
    ['systemctl', buildHostTakeoverRootCommandScript('systemctl', ['/usr/bin/systemctl'], { bypassUserFlag: '--user' })],
    ['service', buildHostTakeoverRootCommandScript('service', ['/usr/sbin/service', '/usr/bin/service'])],
    ['loginctl', buildHostTakeoverRootCommandScript('loginctl', ['/usr/bin/loginctl'])],
    ['journalctl', buildHostTakeoverRootCommandScript('journalctl', ['/usr/bin/journalctl'], { bypassUserFlag: '--user' })],
    ['mount', buildHostTakeoverRootCommandScript('mount', ['/usr/bin/mount', '/bin/mount'])],
    ['umount', buildHostTakeoverRootCommandScript('umount', ['/usr/bin/umount', '/bin/umount'])],
    ['chown', buildHostTakeoverRootCommandScript('chown', ['/usr/bin/chown', '/bin/chown'])],
    ['chmod', buildHostTakeoverRootCommandScript('chmod', ['/usr/bin/chmod', '/bin/chmod'])],
    ['chgrp', buildHostTakeoverRootCommandScript('chgrp', ['/usr/bin/chgrp', '/bin/chgrp'])],
    ['tee', buildHostTakeoverRootCommandScript('tee', ['/usr/bin/tee'])],
    ['pip', buildHostTakeoverPipScript('pip')],
    ['pip3', buildHostTakeoverPipScript('pip3')],
    ['python', buildHostTakeoverPythonScript('python')],
    ['python3', buildHostTakeoverPythonScript('python3')],
  ]);

  for (const [fileName, content] of scripts.entries()) {
    const filePath = path.join(HOST_TAKEOVER_WRAPPER_DIR, fileName);
    fs.writeFileSync(filePath, content, { mode: 0o755 });
    fs.chmodSync(filePath, 0o755);
  }
}

async function readOpenClawGatewayServiceEnvironmentPath() {
  const { stdout } = await execFilePromise(
    'systemctl',
    ['--user', 'show', OPENCLAW_GATEWAY_SERVICE_NAME, '-p', 'Environment', '--value'],
    {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }
  );
  const normalized = normalizeCliText(stdout);
  const matched = normalized.match(/(?:^|\s)PATH=([^\s]+)/);
  return normalizeCliText(matched?.[1]) || null;
}

export async function reloadOpenClawGatewayUserSystemd() {
  await execFilePromise('systemctl', ['--user', 'daemon-reload'], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}

export async function setHostTakeoverSystemdOverrideEnabled(enabled: boolean) {
  if (enabled) {
    const currentPath = await readOpenClawGatewayServiceEnvironmentPath();
    if (!currentPath) {
      throw new StructuredRequestError(
        500,
        GATEWAY_HOST_TAKEOVER_SERVICE_NOT_FOUND_ERROR_CODE,
        `Could not detect ${OPENCLAW_GATEWAY_SERVICE_NAME} or its PATH environment.`
      );
    }

    const nextPath = prependPathEntry(currentPath, HOST_TAKEOVER_WRAPPER_DIR);
    fs.mkdirSync(path.dirname(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(
      HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH,
      `[Service]\nEnvironment=PATH=${nextPath}\n`
    );
  } else {
    fs.rmSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, { force: true });
  }

  await reloadOpenClawGatewayUserSystemd();
}

export async function installHostTakeoverHelper(password?: string | null) {
  const userName = getCurrentUserName();
  if (!fs.existsSync(HOST_TAKEOVER_INSTALLER_SCRIPT_PATH)) {
    throw new StructuredRequestError(
      500,
      GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
      `Host takeover installer script not found at ${HOST_TAKEOVER_INSTALLER_SCRIPT_PATH}.`
    );
  }

  const installerArgs = [
    '/bin/bash',
    HOST_TAKEOVER_INSTALLER_SCRIPT_PATH,
    '--user',
    userName,
    '--helper-path',
    HOST_TAKEOVER_SYSTEM_HELPER_PATH,
    '--sudoers-path',
    getHostTakeoverSudoersPath(userName),
  ];

  if (fs.existsSync(HOST_TAKEOVER_SYSTEM_HELPER_PATH)) {
    try {
      const { stdout } = await execFilePromise('sudo', ['-n', HOST_TAKEOVER_SYSTEM_HELPER_PATH, '/usr/bin/id', '-u'], {
        timeout: 5000,
        maxBuffer: 16 * 1024,
      });
      if (normalizeCliText(stdout) === '0') {
        return;
      }
    } catch {}
  }

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    try {
      await execFilePromise(installerArgs[0], installerArgs.slice(1), {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return;
    } catch (error: any) {
      throw new StructuredRequestError(
        500,
        GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
        readCliErrorDetail(error) || error?.message || 'Failed to install the host takeover helper.'
      );
    }
  }

  try {
    await execFilePromise('sudo', ['-n', ...installerArgs], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return;
  } catch (error: any) {
    const detail = readCliErrorDetail(error) || error?.message || 'Failed to install the host takeover helper.';
    if (!password && needsSudoPassword(detail)) {
      throw new StructuredRequestError(
        409,
        GATEWAY_HOST_TAKEOVER_CREDENTIALS_REQUIRED_ERROR_CODE,
        'Installing host takeover needs the current system user password.',
        { userName }
      );
    }

    if (!password) {
      throw new StructuredRequestError(
        500,
        GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
        detail
      );
    }
  }

  try {
    await execFileWithInput(
      'sudo',
      ['-S', '-k', '-p', '', ...installerArgs],
      `${password}\n`,
      { timeout: 20000 }
    );
  } catch (error: any) {
    const detail = readCliErrorDetail(error) || error?.message || 'Failed to install the host takeover helper.';
    throw new StructuredRequestError(
      500,
      GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
      detail
    );
  }
}

async function readHostTakeoverStatus(enabled = readMaxPermissionsEnabled() === true): Promise<HostTakeoverStatus> {
  const currentUser = getCurrentUserName();
  const autoInstallMode = getHostTakeoverAutoInstallMode();
  const autoInstallSupported = isHostTakeoverAutoInstallSupported();
  const execPreflightBypassStatus = enabled
    ? readOpenClawExecPreflightBypassStatus()
    : {
        ready: false,
        targetCount: 0,
        patchedCount: 0,
        rawDetail: null,
        targets: [],
      } satisfies OpenClawExecPreflightBypassStatus;
  const helperInstalled = fs.existsSync(HOST_TAKEOVER_SYSTEM_HELPER_PATH);
  const overrideContent = fs.existsSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH)
    ? fs.readFileSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, 'utf-8')
    : '';
  const overridePathPatched = normalizeCliText(overrideContent).includes(HOST_TAKEOVER_WRAPPER_DIR);
  let helperReachable = false;
  let servicePathPatched = false;
  let rawDetail: string | null = null;

  if (helperInstalled) {
    try {
      const { stdout } = await execFilePromise(
        'sudo',
        ['-n', HOST_TAKEOVER_SYSTEM_HELPER_PATH, '/usr/bin/id', '-u'],
        {
          timeout: 5000,
          maxBuffer: 16 * 1024,
        }
      );
      helperReachable = normalizeCliText(stdout) === '0';
      if (!helperReachable) {
        rawDetail = 'The host takeover helper responded, but did not confirm root execution.';
      }
    } catch (error: any) {
      rawDetail = normalizeCliText(error?.stderr) || normalizeCliText(error?.message) || 'The host takeover helper is installed but not reachable.';
    }
  }

  try {
    const servicePath = await readOpenClawGatewayServiceEnvironmentPath();
    servicePathPatched = normalizePathEntries(servicePath).includes(HOST_TAKEOVER_WRAPPER_DIR) || overridePathPatched;
  } catch (error: any) {
    servicePathPatched = overridePathPatched;
    rawDetail = rawDetail || normalizeCliText(error?.stderr) || normalizeCliText(error?.message) || `Could not inspect ${OPENCLAW_GATEWAY_SERVICE_NAME}.`;
  }

  const ready = helperReachable
    && servicePathPatched
    && (!enabled || execPreflightBypassStatus.ready);
  let mode: HostTakeoverMode = 'disabled';

  if (!enabled) {
    mode = 'disabled';
  } else if (ready) {
    mode = 'ready';
  } else if (!helperInstalled) {
    mode = 'needs_install';
    rawDetail = rawDetail || 'The host takeover helper has not been installed yet.';
  } else {
    mode = 'broken';
    rawDetail = rawDetail
      || execPreflightBypassStatus.rawDetail
      || 'The host takeover chain is incomplete.';
  }

  return {
    enabled,
    mode,
    ready,
    helperInstalled,
    helperReachable,
    servicePathPatched,
    execPreflightBypassReady: enabled && execPreflightBypassStatus.ready,
    execPreflightTargetCount: execPreflightBypassStatus.targetCount,
    execPreflightPatchedCount: execPreflightBypassStatus.patchedCount,
    currentUser,
    wrapperDir: HOST_TAKEOVER_WRAPPER_DIR,
    hostRootPath: HOST_TAKEOVER_HOST_ROOT_PATH,
    helperPath: HOST_TAKEOVER_SYSTEM_HELPER_PATH,
    autoInstallSupported,
    autoInstallMode,
    manualInstallCommand: buildHostTakeoverManualInstallCommand(),
    rawDetail,
  };
}

export async function safeReadHostTakeoverStatus(enabled = readMaxPermissionsEnabled() === true): Promise<HostTakeoverStatus> {
  try {
    return await readHostTakeoverStatus(enabled);
  } catch (error: any) {
    const execPreflightBypassStatus = enabled
      ? readOpenClawExecPreflightBypassStatus()
      : {
          ready: false,
          targetCount: 0,
          patchedCount: 0,
          rawDetail: null,
          targets: [],
        } satisfies OpenClawExecPreflightBypassStatus;
    return {
      enabled,
      mode: enabled ? 'broken' : 'disabled',
      ready: false,
      helperInstalled: fs.existsSync(HOST_TAKEOVER_SYSTEM_HELPER_PATH),
      helperReachable: false,
      servicePathPatched: false,
      execPreflightBypassReady: enabled && execPreflightBypassStatus.ready,
      execPreflightTargetCount: execPreflightBypassStatus.targetCount,
      execPreflightPatchedCount: execPreflightBypassStatus.patchedCount,
      currentUser: getCurrentUserName(),
      wrapperDir: HOST_TAKEOVER_WRAPPER_DIR,
      hostRootPath: HOST_TAKEOVER_HOST_ROOT_PATH,
      helperPath: HOST_TAKEOVER_SYSTEM_HELPER_PATH,
      autoInstallSupported: isHostTakeoverAutoInstallSupported(),
      autoInstallMode: getHostTakeoverAutoInstallMode(),
      manualInstallCommand: buildHostTakeoverManualInstallCommand(),
      rawDetail: execPreflightBypassStatus.rawDetail
        || normalizeCliText(error?.stderr)
        || normalizeCliText(error?.message)
        || 'Failed to inspect host takeover status.',
    };
  }
}

export function buildHostTakeoverChatInstruction() {
  const currentUser = getCurrentUserName();
  return [
    '【Host takeover】',
    'Maximum permissions are enabled. You can directly operate this Linux host and use root when required.',
    'Treat installed host tools as part of your execution environment: if a command-line tool exists on this machine, you should discover it from PATH and use it directly instead of claiming the product lacks that capability.',
    'For uploaded files or workspace files, use their absolute paths. When the model cannot natively understand a file type, first call the appropriate local tool to inspect, transcribe, convert, extract, or summarize it, then continue the task.',
    'Under maximum permissions, OpenClaw internal exec/script preflight interception is also bypassed, so complex shell and interpreter command sequences may be executed directly when needed.',
    buildManagedDocumentToolingInstruction(),
    `Immediate root entrypoint: ${HOST_TAKEOVER_HOST_ROOT_PATH}`,
    `Run a single root command with: ${HOST_TAKEOVER_HOST_ROOT_PATH} /usr/bin/id -u`,
    `Run a complex root shell with: ${HOST_TAKEOVER_HOST_ROOT_PATH} /bin/sh -lc '<command>'`,
    `To drop back to the normal user, run: ${HOST_TAKEOVER_HOST_ROOT_PATH} --as-user ${currentUser} -- <command>`,
    'After the OpenClaw gateway restarts, common commands such as sudo, apt, apt-get, pip, python -m pip, systemctl, journalctl, mount, umount, chmod, chown, and tee will also flow through the takeover wrappers automatically.',
  ].join('\n');
}

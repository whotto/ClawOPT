/**
 * 服务端 shell 白名单（spec 07 §3.2 第 14 条：参考实现让客户端指定任意 shell 路径）。
 *
 * 客户端只能发 `shellId`（`bash` / `zsh` / …），路径永远由这里给；不在名单里的 id、任何带斜杠的值一律拒绝。
 * 名单 = 固定候选路径里真实存在且可执行的那些；登录 shell（`$SHELL`）只有当它**恰好是**候选路径之一时才标成默认。
 */
import fs from 'fs';

export type TerminalShell = { id: string; path: string; label: string; isDefault: boolean };

export const SHELL_CANDIDATES: readonly { id: string; paths: string[]; label: string }[] = [
  { id: 'bash', paths: ['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash'], label: 'bash' },
  { id: 'zsh', paths: ['/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh', '/usr/local/bin/zsh'], label: 'zsh' },
  { id: 'fish', paths: ['/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'], label: 'fish' },
  { id: 'sh', paths: ['/bin/sh', '/usr/bin/sh'], label: 'sh' },
];

const SHELL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function detectShells(options: { loginShell?: string | undefined; isExecutable?: (path: string) => boolean } = {}): TerminalShell[] {
  const executable = options.isExecutable ?? isExecutableFile;
  const found: TerminalShell[] = [];
  for (const candidate of SHELL_CANDIDATES) {
    const hit = candidate.paths.find((entry) => executable(entry));
    if (hit) found.push({ id: candidate.id, path: hit, label: candidate.label, isDefault: false });
  }
  const login = options.loginShell;
  const loginMatch = login ? found.find((shell) => SHELL_CANDIDATES.find((c) => c.id === shell.id)?.paths.includes(login)) : undefined;
  const preferred = loginMatch ?? found.find((shell) => shell.id === 'bash') ?? found[0];
  if (preferred) preferred.isDefault = true;
  return found;
}

/** 把客户端给的 shellId 换成白名单里的 shell；不认识、带路径分隔符、为空都返回 null。缺省给默认 shell。 */
export function resolveShell(shells: readonly TerminalShell[], shellId: unknown): TerminalShell | null {
  if (shellId === undefined || shellId === null || shellId === '') return shells.find((shell) => shell.isDefault) ?? null;
  if (typeof shellId !== 'string' || !SHELL_ID_PATTERN.test(shellId)) return null;
  return shells.find((shell) => shell.id === shellId) ?? null;
}

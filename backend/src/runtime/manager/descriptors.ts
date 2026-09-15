/**
 * 内置运行时描述符。包名、命令名 2026-09-14 实测（`npm view` / PyPI wheel 的 entry_points），
 * 记录在 docs/planning/…/90.过程/P2-platform-报告.md。**版本不钉**：安装与升级都装最新。
 *
 * 原生文件表来自 spec 04 §2.2 / §4；hermes 的路径取自 hermes-agent 0.19.0 源码
 * （`~/.hermes/config.yaml` 里的 `mcp_servers`、`SOUL.md`、`.env` / `auth.json`，`HERMES_HOME` 覆盖）。
 */
import type { RuntimeDescriptor } from './types';

const SHARED_AGENT_SKILLS = { path: '~/.agents/skills', shared: true } as const;

export const BUILTIN_RUNTIME_DESCRIPTORS: readonly RuntimeDescriptor[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    command: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    installKind: 'npm',
    versionArgs: ['--version'],
    nativeFiles: {
      preference: { path: '~/.claude/CLAUDE.md', language: 'markdown' },
      config: { path: '~/.claude/settings.json', language: 'json' },
      mcp: { path: '~/.claude/mcp.json', language: 'json', format: 'claude-json' },
      auth: [{ path: '~/.claude/.credentials.json', language: 'json' }],
      skills: [{ path: '~/.claude/skills', shared: false }],
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    command: 'codex',
    npmPackage: '@openai/codex',
    installKind: 'npm',
    officialRegistry: true,
    versionArgs: ['--version'],
    nativeFiles: {
      homeEnv: { variable: 'CODEX_HOME', homeDir: '.codex' },
      preference: { path: '~/.codex/AGENTS.md', language: 'markdown' },
      config: { path: '~/.codex/config.toml', language: 'toml' },
      mcp: { path: '~/.codex/config.toml', language: 'toml', format: 'codex-toml' },
      auth: [{ path: '~/.codex/auth.json', language: 'json' }],
      skills: [SHARED_AGENT_SKILLS, { path: '~/.codex/skills', shared: false }],
    },
  },
  {
    id: 'pi',
    name: 'Pi',
    vendor: 'Earendil',
    command: 'pi',
    npmPackage: '@earendil-works/pi-coding-agent',
    installKind: 'npm',
    versionArgs: ['--version'],
    nativeFiles: {
      preference: { path: '~/.pi/agent/AGENTS.md', language: 'markdown' },
      config: { path: '~/.pi/agent/settings.json', language: 'json' },
      mcp: { path: '~/.pi/agent/mcp.json', language: 'json', format: 'pi-json' },
      auth: [{ path: '~/.pi/agent/auth.json', language: 'json' }],
      skills: [SHARED_AGENT_SKILLS],
    },
  },
  {
    id: 'grok',
    name: 'Grok Build',
    vendor: 'xAI',
    command: 'grok',
    npmPackage: '@xai-official/grok',
    installKind: 'npm',
    officialRegistry: true,
    versionArgs: ['--version'],
    nativeFiles: {
      homeEnv: { variable: 'GROK_HOME', homeDir: '.grok' },
      preference: { path: '~/.grok/AGENTS.md', language: 'markdown' },
      config: { path: '~/.grok/config.toml', language: 'toml' },
      mcp: { path: '~/.grok/config.toml', language: 'toml', format: 'grok-toml' },
      auth: [{ path: '~/.grok/auth.json', language: 'json' }],
      skills: [{ path: '~/.grok/skills', shared: false }, SHARED_AGENT_SKILLS],
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'SST',
    command: 'opencode',
    npmPackage: 'opencode-ai',
    installKind: 'npm',
    officialRegistry: true,
    versionArgs: ['--version'],
    nativeFiles: {
      preference: { path: '~/.config/opencode/AGENTS.md', language: 'markdown' },
      config: { path: '~/.config/opencode/opencode.json', language: 'json' },
      mcp: { path: '~/.config/opencode/opencode.json', language: 'json', format: 'opencode-json' },
      auth: [{ path: '~/.local/share/opencode/auth.json', language: 'json' }],
      skills: [{ path: '~/.config/opencode/skills', shared: false }, SHARED_AGENT_SKILLS],
    },
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    command: 'dsh',
    npmPackage: '@deepseek-ai/dsh',
    installKind: 'npm',
    officialRegistry: true,
    prereleaseAware: true,
    versionArgs: ['--version'],
    nativeFiles: {
      homeEnv: { variable: 'DSH_HOME', homeDir: '.dsh' },
      preference: { path: '~/.dsh/AGENTS.md', language: 'markdown' },
      config: { path: '~/.dsh/settings.yaml', language: 'yaml' },
      mcp: { path: '~/.dsh/cordis.patch.yml', language: 'yaml', format: 'dsh-yaml' },
      skills: [{ path: '~/.dsh/skills', shared: false }],
    },
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    vendor: 'Nous Research',
    command: 'hermes',
    // PyPI 上的 hermes-agent 落后于主线（0.19 vs 0.21，2026-09-15）；官方安装方式是从仓库可编辑安装。
    pipPackage: 'hermes-agent',
    // `hermes acp` 需要 [acp]（不带就启动即退出："ACP dependencies not installed"），经 ACP 注入的 MCP 需要 [mcp]（不带就静默不注册）。集成 P2 实测 0.19.0。
    pipExtras: ['acp', 'mcp'],
    installKind: 'pip',
    pythonRequirement: '>=3.11,<3.14',
    versionArgs: ['--version'],
    nativeFiles: {
      homeEnv: { variable: 'HERMES_HOME', homeDir: '.hermes' },
      preference: { path: '~/.hermes/SOUL.md', language: 'markdown' },
      config: { path: '~/.hermes/config.yaml', language: 'yaml' },
      mcp: { path: '~/.hermes/config.yaml', language: 'yaml', format: 'hermes-yaml' },
      auth: [{ path: '~/.hermes/.env', language: 'dotenv' }, { path: '~/.hermes/auth.json', language: 'json' }],
      skills: [{ path: '~/.hermes/skills', shared: false }],
    },
  },
];

/** 按 id 取内置描述符（适配器的定义引用它，不另写一份包名与命令）。没有就抛：适配器 id 与内置表分家是编码错误。 */
export function builtinRuntimeDescriptor(id: string): RuntimeDescriptor {
  const descriptor = BUILTIN_RUNTIME_DESCRIPTORS.find((entry) => entry.id === id);
  if (!descriptor) throw new Error(`no builtin runtime descriptor for "${id}"`);
  return descriptor;
}

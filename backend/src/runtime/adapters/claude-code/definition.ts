/**
 * Claude Code：描述符、能力、事实来源表。
 *
 * 取值对着本机 `claude` 2.1.272 实测（2026-09-15）：
 * - `--output-format stream-json` 在 `-p` 下强制要求 `--verbose`；
 * - `--include-partial-messages` 给出 `stream_event`（message_start / content_block_* / message_delta）；
 * - `--session-id <客户端 UUID>` 建会话，`--resume <同一 id>` 续上；
 * - `--append-system-prompt-file` 不在 `--help` 里，但存在（传不存在的文件报 "Append system prompt file not found"）；
 * - `--permission-prompts none`：会弹窗的一律拒绝。**从不**用 `--dangerously-skip-permissions`。
 */
import { defineCapabilities, defineSourceOfTruth } from '../../contract';
import type { RuntimeDescriptor } from '../_platform-types';

export const CLAUDE_CODE_DESCRIPTOR: RuntimeDescriptor = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  npmPackage: '@anthropic-ai/claude-code',
  installKind: 'npm',
  versionArgs: ['--version'],
};

export const CLAUDE_CODE_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  // headless 下 `--permission-prompts none`：会弹窗的一律拒绝，没有交互式审批。
  approvals: false,
  clarify: false,
  hostCompression: false,
  // `/compact` 作为一轮普通输入发出去，CLI 回 `system/compact_boundary`。
  nativeCompact: true,
  backgroundDelegation: false,
  images: true,
  mcpInjection: true,
  proxyMode: ['global', 'scoped'],
});

/**
 * 文本、工具、终态都只信 CLI 的 stream-json：代理 tee 看到的是同一轮的另一份描述，id 不同。
 * 用量：scoped 下代理看得到真实计费；global 只能信 CLI 的 result。
 */
export const CLAUDE_CODE_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

/** global 模式放行的凭据变量：Anthropic 自己的、Bedrock / Vertex / Foundry 的开关与凭据。 */
export const CLAUDE_CODE_GLOBAL_CREDENTIAL_ENV: readonly RegExp[] = [
  /^ANTHROPIC_/, /^CLAUDE_CODE_/, /^CLAUDE_CONFIG_DIR$/, /^AWS_/, /^GOOGLE_APPLICATION_CREDENTIALS$/, /^CLOUD_ML_REGION$/, /^VERTEX_/, /^AZURE_/,
];

/**
 * Pi（`@earendil-works/pi-coding-agent`）：描述符、能力、事实来源表。
 *
 * 对着本机 `pi` 0.85.1 实测（2026-09-15）与随包文档 docs/rpc.md、docs/models.md：
 * - `pi --mode rpc`：stdin 收命令（prompt / abort / compact / get_state / get_session_stats / set_thinking_level /
 *   extension_ui_response），stdout 出事件，严格 LF 分帧；
 * - `--session-id <id>` + `--session-dir <dir>`：「按确切 id 用项目会话，没有就建」（实测会先打一行警告再建）；
 *   同一 id 在新进程里接着用就是续话——所以每轮一个进程，本轮 `agent_settled` 之后停掉；
 * - `agent_settled` 是**唯一可靠的边界**：自动重试时会先来 `agent_end {willRetry: true}`；
 * - 审批 / 澄清是真的：扩展的 `ctx.ui.confirm/select/input/editor` 在 RPC 下变成 `extension_ui_request`，
 *   阻塞到客户端回 `extension_ui_response`（带 timeout 的由 Pi 自己到点兜底）。
 */
import { defineCapabilities, defineSourceOfTruth } from '../../contract';
import { builtinRuntimeDescriptor } from '../../manager/descriptors';
import type { RuntimeDescriptor } from '../../manager/types';

/** 描述符（包名、命令、原生文件表）只在运行时管理器的内置表里写一份。 */
export const PI_DESCRIPTOR: RuntimeDescriptor = builtinRuntimeDescriptor('pi');

export const PI_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  approvals: true,
  clarify: true,
  hostCompression: false,
  nativeCompact: true,
  backgroundDelegation: false,
  images: true,
  mcpInjection: false,
  proxyMode: ['global', 'scoped'],
});

export const PI_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

/** Pi 支持几十家服务商，凭据变量没有统一前缀：按「看起来是凭据」的名字放行（仍然不是整份环境）。 */
export const PI_GLOBAL_CREDENTIAL_ENV: readonly RegExp[] = [
  /_API_KEY$/, /_AUTH_TOKEN$/, /_OAUTH_TOKEN$/, /^ANTHROPIC_/, /^OPENAI_/, /^AZURE_OPENAI_/, /^AWS_/, /^CLOUDFLARE_/,
  /^GOOGLE_/, /^PI_/,
];
